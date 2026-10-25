import Darwin
import Foundation
import ServiceManagement

// obligations-server — the executable inside Obligations Server.app.
//
//   obligations-server run server      launchd: node server.mjs, sandboxed
//   obligations-server run dispatch    launchd: python3 reminder-dispatch.py, sandboxed
//   obligations-server register        Obligations.app: register both launchd agents
//   obligations-server unregister      Obligations.app: remove them
//   obligations-server enable|disable  Obligations.app: the switch that says this Mac is the server
//   obligations-server status          Obligations.app: JSON on stdout
//
// It never runs anything unsandboxed. If the profile, node, or the repo is
// missing it says so and exits with EX_CONFIG rather than falling back to
// running the agent bare — a server that is down is visible; one that quietly
// came up without its sandbox is not.

let labels = (server: "com.example.obligations.server", dispatch: "com.example.obligations.dispatch")
let node = "/opt/homebrew/opt/node@22/bin/node"   // pinned: the version the image tests against
let python = "/usr/bin/python3"
let defaults = UserDefaults.standard                // com.example.obligations.server
let fm = FileManager.default
let home = fm.homeDirectoryForCurrentUser.path

func say(_ s: String) {
    FileHandle.standardError.write(Data("\(Stamp.now())  \(s)\n".utf8))
}

func fail(_ s: String, code: Int32 = 78) -> Never {    // 78 = EX_CONFIG
    say(s)
    exit(code)
}

enum Stamp {
    static func now() -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return f.string(from: Date())
    }
}

// MARK: - where things are

/// The working copy. One copy, as on linuxbox: the jobs commit to it and the
/// developer sessions work in it.
var repo: String {
    defaults.string(forKey: "repo") ?? "\(home)/Developer/obligations"
}

/// The profile shipped in this bundle — never the repo's copy, which the
/// agent can edit. Changing the sandbox takes a human rebuilding this app.
var profile: String? {
    Bundle.main.resourceURL?.appendingPathComponent("server.sb").path
}

var userTempDir: String {
    var buf = [CChar](repeating: 0, count: Int(PATH_MAX))
    let n = confstr(_CS_DARWIN_USER_TEMP_DIR, &buf, buf.count)
    let dir = n > 0 ? String(cString: buf) : NSTemporaryDirectory()
    return dir.hasSuffix("/") ? String(dir.dropLast()) : dir
}

/// The switch that says this Mac is the assistant's server.
///
/// Off by default, and turned on at cutover, deliberately. Registering the
/// agents starts them; if that happened on a Mac while linuxbox was still live,
/// two schedulers would run the same jobs and two dispatchers would push the
/// same reminders — the September outbox rule ("never both") for the whole
/// server. A launch while this is off exits 0, and launchd leaves it down.
///
/// The sandbox denies preference writes, so the agent cannot flip it.
var enabled: Bool { defaults.bool(forKey: "enabled") }

// MARK: - the environment

/// `deploy/.env`, read the way `docker run --env-file` read it on linuxbox:
/// KEY=VALUE per line, comments and blanks skipped, the value taken literally
/// with no quote handling. Matching docker's rules exactly means a value that
/// worked there means the same thing here.
func envFile(_ path: String) -> [String: String] {
    guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return [:] }
    var out: [String: String] = [:]
    for raw in text.split(separator: "\n", omittingEmptySubsequences: true) {
        let line = raw.trimmingCharacters(in: .whitespaces)
        if line.isEmpty || line.hasPrefix("#") { continue }
        guard let eq = line.firstIndex(of: "=") else { continue }
        let key = String(line[..<eq]).trimmingCharacters(in: .whitespaces)
        guard !key.isEmpty else { continue }
        out[key] = String(line[line.index(after: eq)...])
    }
    return out
}

/// The long-lived token from "Sign in with Claude" in Obligations.app — Curated's
/// process (`claude setup-token`). Read here, OUTSIDE the sandbox, and handed
/// over in the environment, so the profile can deny the folder it lives in.
func claudeToken() -> String? {
    let path = "\(home)/.obligations-server/claude-token"
    guard let raw = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
    let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard token.hasPrefix("sk-ant-"), !token.contains(where: \.isWhitespace) else {
        say("claude-token is present but is not a token from `claude setup-token`; ignoring it")
        return nil
    }
    return token
}

/// A clean environment, not launchd's, built from three layers: deploy/.env,
/// then what this Mac requires, then the credential. The later layers win, so
/// nothing in the agent-writable .env can move the server off loopback, off
/// its port, or out of the repo.
func environment() -> [String: String] {
    var env = envFile("\(repo)/deploy/.env")
    let tmp = userTempDir
    let forced: [String: String] = [
        "HOME": home,
        "USER": NSUserName(),
        "LOGNAME": NSUserName(),
        "TMPDIR": tmp + "/",
        "LANG": "en_US.UTF-8",
        "PATH": "/opt/homebrew/opt/node@22/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
        "OBLIGATIONS": repo,
        "OBLIGATIONS_NODE_MODULES": "\(repo)/deploy/agent-service/node_modules",
        "CLAUDE_CONFIG_DIR": "\(repo)/deploy/claude-home",
        "HOST": "127.0.0.1",      // the tunnel is Tavern's, on loopback
        "PORT": "7683",           // the one port the profile lets it bind
        // As the image did: commits by the jobs are authored by "obligations".
        "GIT_AUTHOR_NAME": "obligations",
        "GIT_AUTHOR_EMAIL": "obligations@localhost",
        "GIT_COMMITTER_NAME": "obligations",
        "GIT_COMMITTER_EMAIL": "obligations@localhost",
        // Local wall clock, from the system — never a TZ inherited by accident.
        // run.sh's timedatectl lookup fell back to UTC on anything but Linux,
        // which is the "jobs fired four hours early" bug.
        "TZ": TimeZone.current.identifier,
    ]
    for (k, v) in forced { env[k] = v }
    // Pushing to GitHub from inside the sandbox, which denies ~/.ssh: the
    // dispatcher's push_backup uses this key, scoped to obligations alone, and
    // GitHub's host keys pinned beside it. -F /dev/null so no ~/.ssh/config is
    // consulted either. The agent can read this key. Branch protection on
    // main would make that safe and is refused without GitHub Pro on a private
    // repo (2026-10-01); until then the deny list and the approval card hold a
    // force-push back, and jobs cannot push at all.
    let key = "\(repo)/deploy/github/deploy_key"
    if fm.fileExists(atPath: key) {
        env["GIT_SSH_COMMAND"] = "/usr/bin/ssh -F /dev/null -i '\(key)' -o IdentitiesOnly=yes "
            + "-o UserKnownHostsFile='\(repo)/deploy/github/known_hosts' -o StrictHostKeyChecking=yes "
            + "-o BatchMode=yes"
    }
    // OBLIGATIONS_SMOKE=1 boots everything but the socket and exits after one tick
    // without running a job — the only safe way to exercise this launcher on
    // a Mac that is not yet the server. Passed through for that and nothing else.
    if let smoke = ProcessInfo.processInfo.environment["OBLIGATIONS_SMOKE"] { env["OBLIGATIONS_SMOKE"] = smoke }
    if let token = claudeToken() {
        env["CLAUDE_CODE_OAUTH_TOKEN"] = token
    }
    return env
}

// MARK: - the trust record

/// Mark the repo a trusted workspace in the Claude config, every start.
///
/// Claude Code applies `.claude/settings.json`'s allow list only in a trusted
/// workspace, and keeps the record in `.claude.json` — which moves INTO
/// CLAUDE_CONFIG_DIR when that is set. On 2026-09-21 setting it swapped in a
/// fresh record with /obligations untrusted: every tool fell through to canUseTool
/// and was refused, and both triages ran for two hours doing nothing while
/// reporting success (deploy/CLAUDE.md). The image baked the record in; here
/// it is merged in — never clobbered, because the CLI rewrites this file.
func ensureTrust(configDir: String) {
    try? fm.createDirectory(atPath: configDir, withIntermediateDirectories: true,
                            attributes: [.posixPermissions: 0o700])
    let path = "\(configDir)/.claude.json"
    var root: [String: Any] = [:]
    if let data = fm.contents(atPath: path) {
        guard let parsed = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            // Unreadable: do not overwrite what the CLI may be mid-way through
            // writing. Say so; the next start tries again.
            say("trust: \(path) is not readable JSON; leaving it alone this start")
            return
        }
        root = parsed
    }
    var projects = root["projects"] as? [String: Any] ?? [:]
    var entry = projects[repo] as? [String: Any] ?? [:]
    if entry["hasTrustDialogAccepted"] as? Bool == true { return }
    entry["hasTrustDialogAccepted"] = true
    projects[repo] = entry
    root["projects"] = projects
    guard let out = try? JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted]) else { return }
    let tmp = path + ".obligations-server.tmp"
    if fm.createFile(atPath: tmp, contents: out, attributes: [.posixPermissions: 0o600]),
       (try? fm.replaceItemAt(URL(fileURLWithPath: path), withItemAt: URL(fileURLWithPath: tmp))) != nil
        || (try? fm.moveItem(atPath: tmp, toPath: path)) != nil {
        say("trust: marked \(repo) trusted in \(path)")
    } else {
        say("trust: could not write \(path) — the allow list will be ignored until this works")
    }
}

// MARK: - run

/// launchd cannot expand ~ in a plist path, and a bundle's plists cannot name
/// a user's home. So the launcher points its own stdout/stderr at
/// ~/Library/Logs/Obligations Server/<which>.log before anything else — and exec
/// hands those descriptors to node and python, so their output lands there too.
/// The sandbox checks a file when it is opened, not when an inherited
/// descriptor is written, so this needs no allowance in the profile.
func logTo(_ which: String) {
    let dir = "\(home)/Library/Logs/Obligations Server"
    try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let fd = open("\(dir)/\(which).log", O_WRONLY | O_CREAT | O_APPEND, 0o644)
    guard fd >= 0 else { return }
    dup2(fd, STDOUT_FILENO)
    dup2(fd, STDERR_FILENO)
    close(fd)
}

func run(_ which: String) -> Never {
    // A smoke boot (OBLIGATIONS_SMOKE=1) starts no work and prints its verdict for
    // the caller — deploy/smoke.sh — so it keeps the caller's stdout and is
    // allowed while this Mac is not yet the server. Everything else logs.
    let smoke = ProcessInfo.processInfo.environment["OBLIGATIONS_SMOKE"] != nil
    if !smoke { logTo(which) }
    guard enabled || (smoke && which == "server") else {
        // The dispatcher is started every minute; saying "not the server" 1,440
        // times a day says nothing the server agent's one line does not.
        if which == "dispatch" { exit(0) }
        say("\(which): this Mac is not the assistant's server (Obligations Server is disabled) — not starting")
        exit(0)
    }
    guard let profile, fm.fileExists(atPath: profile) else {
        fail("\(which): the sandbox profile is missing from the bundle — refusing to run unsandboxed")
    }
    guard fm.fileExists(atPath: "\(repo)/deploy/agent-service/server.mjs") else {
        fail("\(which): no Obligations repo at \(repo)")
    }

    let program: [String]
    switch which {
    case "server":
        guard fm.isExecutableFile(atPath: node) else {
            fail("server: \(node) is missing — `brew install node@22`")
        }
        guard fm.fileExists(atPath: "\(repo)/deploy/agent-service/node_modules/@anthropic-ai/claude-agent-sdk") else {
            fail("server: the agent SDK is not installed — `cd deploy/agent-service && npm ci`")
        }
        ensureTrust(configDir: "\(repo)/deploy/claude-home")
        program = [node, "\(repo)/deploy/agent-service/server.mjs"]
    case "dispatch":
        program = [python, "\(repo)/deploy/reminder-dispatch.py"]
    default:
        fail("unknown: run \(which)", code: 64)
    }

    let env = environment()
    if ProcessInfo.processInfo.environment["OBLIGATIONS_SERVER_PRINT_ENV"] != nil {
        for (k, v) in env.sorted(by: { $0.key < $1.key }) {
            say("env \(k)=\(k.contains("TOKEN") || k.contains("KEY") || k.contains("PASS") ? "<set>" : v)")
        }
    }
    if which == "server" {
        say("server: starting in \(repo), Claude credential: "
            + (env["CLAUDE_CODE_OAUTH_TOKEN"] != nil ? "token"
               : env["ANTHROPIC_API_KEY"] != nil ? "api-key" : "none — sign in from the Obligations menu"))
    }

    guard fm.changeCurrentDirectoryPath(repo) else { fail("\(which): cannot enter \(repo)") }

    let argv = ["/usr/bin/sandbox-exec", "-f", profile,
                "-D", "OBLIGATIONS=\(repo)", "-D", "HOME=\(home)", "-D", "TMPDIR=\(userTempDir)"] + program
    let cArgs = argv.map { strdup($0) } + [nil]
    let cEnv = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
    // exec carries the signal mask and every ignored signal into the child;
    // hand node a clean slate rather than whatever Foundation left here.
    // (Suspected, and cleared, while chasing a silent abort on 2026-10-01 —
    // it was not the cause: that was node fstat()ing a log descriptor the
    // sandbox would not stat. See the log allowance in server.sb.)
    var none = sigset_t()
    sigemptyset(&none)
    sigprocmask(SIG_SETMASK, &none, nil)
    for sig in 1..<NSIG { signal(sig, SIG_DFL) }

    // exec, not spawn: launchd then watches the sandboxed process itself, so
    // KeepAlive restarts the server and not a launcher left waiting on it.
    execve(argv[0], cArgs, cEnv)
    fail("\(which): execve failed: \(String(cString: strerror(errno)))", code: 71)
}

// MARK: - the controls Obligations.app drives

func agent(_ label: String) -> SMAppService {
    SMAppService.agent(plistName: "\(label).plist")
}

func describe(_ s: SMAppService.Status) -> String {
    switch s {
    case .enabled: return "enabled"
    case .notRegistered: return "not-registered"
    case .requiresApproval: return "requires-approval"
    case .notFound: return "not-found"
    @unknown default: return "unknown"
    }
}

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "run":
    run(args.count > 1 ? args[1] : "")

case "register":
    var failed = false
    for label in [labels.server, labels.dispatch] {
        do {
            try agent(label).register()
            print("\(label): \(describe(agent(label).status))")
        } catch {
            print("\(label): could not register — \(error.localizedDescription)")
            failed = true
        }
    }
    exit(failed ? 1 : 0)

case "unregister":
    for label in [labels.server, labels.dispatch] {
        try? agent(label).unregister()
        print("\(label): \(describe(agent(label).status))")
    }
    exit(0)

case "enable":
    defaults.set(true, forKey: "enabled")
    print("enabled")
    exit(0)

case "disable":
    defaults.set(false, forKey: "enabled")
    print("disabled")
    exit(0)

case "status":
    let doc: [String: Any] = [
        "enabled": enabled,
        "repo": repo,
        "profile": profile ?? "",
        "profile_present": profile.map { fm.fileExists(atPath: $0) } ?? false,
        "node_present": fm.isExecutableFile(atPath: node),
        "claude_token_present": claudeToken() != nil,
        "agents": [
            labels.server: describe(agent(labels.server).status),
            labels.dispatch: describe(agent(labels.dispatch).status),
        ],
    ]
    let data = try! JSONSerialization.data(withJSONObject: doc, options: [.prettyPrinted, .sortedKeys])
    print(String(decoding: data, as: UTF8.self))
    exit(0)

default:
    print("""
    usage: obligations-server run server|dispatch
           obligations-server register|unregister|enable|disable|status
    """)
    exit(64)
}
