#!/usr/bin/env python3
"""The CronJob schedules and moments the next-run cases cover, one JSON line each: every zone's clock changes in
2026 (a moment before, at and after), fixed times inside the skipped and the repeated hour, intervals running through
them, lists, ranges, steps, names, both day fields, descriptors, @every, a zone inside the schedule, and schedules
kube-controller-manager refuses."""
import datetime as dt
import json
from zoneinfo import ZoneInfo

CHANGING = [
    'America/New_York', 'Europe/Berlin', 'Europe/London', 'Australia/Sydney', 'Australia/Lord_Howe',
    'America/Santiago', 'Pacific/Chatham', 'America/St_Johns',
]
STEADY = ['Asia/Kolkata', 'Asia/Seoul', 'UTC']

# schedules a clock change can move: read in every zone, at moments around each change
AROUND_CHANGES = [
    # fixed times in or near the hours a clock change skips or repeats
    '0 2 * * *', '30 2 * * *', '59 2 * * *', '0 3 * * *', '30 1 * * *', '0 1 * * *', '45 0 * * *', '15 2 * * 0',
    # intervals through them
    '*/15 * * * *', '0 * * * *', '30 1,2 * * *', '0 1-3 * * *', '5/20 * * * *', '10-50/10 1-4 * * *', '0 */2 * * *',
    '@daily', '@hourly', '@weekly',
]

# the parser's rules: read in three zones at the fixed moments
RULES = [
    # days, months, names
    '0 0 1 * 1', '0 0 13 * 5', '0 0 * * 1', '0 0 1 * *', '0 12 29 2 *', '0 0 30 2 *', '0 9 * * mon-fri',
    '0 0 * JAN,jul SUN', '0 0 ? * MON', '0 6 1-7 * 0', '0 0 L * *', '0 0 31 * *', '0 0 * * 0,6', '* * * * *',
    # descriptors and intervals in time
    '@yearly', '@annually', '@monthly', '@midnight', '@every 1h30m', '@every 90s', '@every 500ms', '@every 1.5h',
    '@reboot',
    # a zone inside the schedule (taken as it is), and schedules the controller refuses
    'TZ=UTC 0 3 * * *', 'CRON_TZ=Asia/Tokyo 0 9 * * *', 'TZ=Mars/Olympus 0 3 * * *', 'TZ=0 3 * * *',
    '0 0 * * 7', '60 * * * *', '* * * *', '* * * * * *', '0 0 31 2-1 *', '*/0 * * * *', '1-2-3 * * * *',
    '0 0 * * 1/2/3', '-1 * * * *', '+5 * * * *', '0 0 1,,2 * *', '', '   ',
]
RULE_ZONES = ['UTC', 'Asia/Seoul', 'America/New_York']

FIXED = ['2026-01-15T10:20:30.700Z', '2026-06-30T23:59:59Z', '2027-12-31T23:30:00Z', '2028-02-28T12:00:00Z']


def clock_changes(zone, year=2026):
    z = ZoneInfo(zone)
    t = dt.datetime(year, 1, 1, tzinfo=dt.timezone.utc)
    end = dt.datetime(year + 1, 1, 1, tzinfo=dt.timezone.utc)
    prev = t.astimezone(z).utcoffset()
    out = []
    while t < end:
        n = t + dt.timedelta(minutes=15)
        off = n.astimezone(z).utcoffset()
        if off != prev:
            out.append(n)
            prev = off
        t = n
    return out


def moments(zone):
    out = list(FIXED)
    # before the hour, after the first and the second time a repeated :30 passes, at the change, after it
    for change in clock_changes(zone):
        for minutes in (-90, -61, -29.5, -0.5, 0, 29.5, 61):
            out.append((change + dt.timedelta(minutes=minutes)).strftime('%Y-%m-%dT%H:%M:%SZ'))
    return out


def main():
    line = lambda zone, schedule, frm: print(json.dumps({'zone': zone, 'schedule': schedule, 'from': frm}))
    for zone in CHANGING + STEADY:
        for schedule in AROUND_CHANGES:
            for frm in moments(zone):
                line(zone, schedule, frm)
    for zone in RULE_ZONES:
        for schedule in RULES:
            for frm in FIXED:
                line(zone, schedule, frm)
    # a zone the controller cannot load
    for schedule in ('0 3 * * *', '@hourly'):
        line('Mars/Olympus', schedule, FIXED[0])


if __name__ == '__main__':
    main()
