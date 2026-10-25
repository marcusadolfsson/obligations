#!/usr/bin/env python3
"""Normalising a handle into a match key. Shared by every Mac-side extractor.

iMessage writes '+17275551234', Contacts might hold '(727) 555-1234', and the
call log stores a blob. If any two of those normalise differently the identity
layer silently half-works: a call closes a callback task for one contact and not
for another, with nothing to indicate why. One implementation, imported by all.
"""
import re


def phone_key(raw):
    """Last 10 digits — enough for NANP, and long international numbers keep
    their full digit string so two genuinely different numbers cannot collide."""
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", errors="ignore")
    digits = re.sub(r"\D", "", raw or "")
    if not digits:
        return None
    return digits[-10:] if len(digits) >= 10 else digits


def email_key(raw):
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", errors="ignore")
    return (raw or "").strip().lower() or None
