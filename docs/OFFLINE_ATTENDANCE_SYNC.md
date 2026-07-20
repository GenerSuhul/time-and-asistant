# Offline attendance synchronization

## Production boundary

```text
Browser -> authenticated Supabase Edge Function
        -> device_commands (fetch_events)
        -> private VPS worker (127.0.0.1:8799)
        -> Hikvision DeviceGateway (127.0.0.1:18080)
        -> attendance_events / daily_attendance
```

- Hikvision's public UI/API remains available at `http://185.182.187.75:18080` for operator access.
- VPS workers use `http://127.0.0.1:18080`; public hairpin routing is unnecessary.
- Port `8799` remains bound to loopback. It must not be opened, proxied through the vendor Nginx, or called by the browser/Edge runtime.
- `gateway.kyrosoftgs.com` is not part of this attendance flow.

## History API contract

The installed API Testing catalog and live devices support:

```http
POST /ISAPI/AccessControl/AcsEvent?format=json&devIndex=<uuid>
Content-Type: application/json

{
  "AcsEventCond": {
    "searchID": "<stable UUID for this run>",
    "searchResultPosition": 0,
    "maxResults": 30,
    "major": 0,
    "minor": 0,
    "startTime": "2026-07-17T00:00:00-06:00",
    "endTime": "2026-07-17T23:59:59-06:00"
  }
}
```

Although the API accepts `maxResults: 100`, the installed DeviceGateway returns at most 30 records per page. Pagination therefore advances by the actual record count and keeps one `searchID` for the whole run.

## Idempotency

The preferred identity is Hikvision's `serialNo`/event ID scoped to the internal device. If absent, the fallback is SHA-256 over device, employee number, timestamp and raw event type. `attendance_events.unique_key` is unique.

Realtime and offline events share the same identity. A historical fetch therefore fills gaps but skips events already ingested through realtime. Images and biometric/template fields are stripped before persistence.

`source_seen` records every transport that observed the same normalized row. If
a historical scan finds a realtime event it adds `offline` to that array,
preserves a single `unique_key`, and keeps `source = realtime`.

## Authenticated daily contract

The daily report button calls `attendance-sync` with:

```json
{
  "action": "sync_day_and_recalculate",
  "date": "2026-07-17",
  "force": true
}
```

The function returns HTTP 202 with `state: "processing"` and opaque
`command_ids` while the worker scans. The browser polls the same action with
those IDs. Only after every command is terminal does the function calculate the
day and return real `sync` and `report` counters. Changing the selected date
only reads saved rows through `attendance-reports`; it does not silently queue a
device scan.

## Realtime delivery

The callback parser reads Hikvision's nested `AccessControllerEvent` fields,
including `serialNo`, `majorEventType`, `subEventType`, employee number and
attendance status. On this installation, callbacks label the physical Guatemala
wall-clock with the VPS `+02:00` offset while AcsEvent history returns the same
clock with `-06:00`. The callback therefore interprets that wall-clock in
`America/Guatemala`, allowing realtime and history to produce the same key.

The normalized event is persisted before ACK. Device status, cursors and daily
calculation run afterward with debounce. `attendance_events` belongs to the
Supabase Realtime publication, and the live-events page subscribes to INSERT and
UPDATE instead of waiting for report calculation.

## Validated production sample

On 2026-07-17 (`America/Guatemala`), the two requested devices returned 341 history records. The first reconciliation added 67 missing attendance candidates; the second returned the same 341 records and inserted 0 duplicates. Both device runs finished successfully.
