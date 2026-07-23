import { createAdapter } from "../adapters/factory.js";
import type {
  DeviceAdapter, DeviceCommand, DeviceRecord, EmployeeCredentialSnapshot,
  FingerprintEnrollmentResult
} from "../adapters/DeviceAdapter.js";
import { logger } from "../logger.js";
import { supabase } from "../supabase.js";
import { syncDeviceHistoryRange, type HistorySyncSummary } from "./history-sync-worker.js";
import { config } from "../config.js";
import {
  commandErrorCode, isDeterministicFingerprintFailure, sanitizeCommandError
} from "../services/command-errors.js";

let running = false;

type CredentialVerificationResult = {
  credentialType: "verification";
  snapshot: EmployeeCredentialSnapshot;
  repairJobs: string[];
};

type CommandExecutionResult = HistorySyncSummary | FingerprintEnrollmentResult | CredentialVerificationResult | void;

async function executeCommand(adapterCommand: DeviceCommand, device: DeviceRecord): Promise<CommandExecutionResult> {
  if (adapterCommand.command_type === "fetch_events") {
    const from = new Date(String(adapterCommand.payload.from ?? ""));
    const to = new Date(String(adapterCommand.payload.to ?? ""));
    if (!Number.isFinite(from.valueOf()) || !Number.isFinite(to.valueOf()) || from > to) {
      throw new Error("fetch_events requires a valid from/to range");
    }
    return syncDeviceHistoryRange({ from, to, deviceIds: [device.id], trigger: "command" });
  }
  if (adapterCommand.command_type === "enroll_fingerprint" && adapterCommand.payload.mode === "replicate") {
    return replicateFingerprint(adapterCommand, device);
  }
  const adapter = createAdapter(device);
  await adapter.connect();
  try {
    switch (adapterCommand.command_type) {
      case "sync_person":
      case "update_person":
        await adapter.syncPerson(adapterCommand);
        break;
      case "sync_device_people":
        if (adapterCommand.payload.mode === "verify_employee_credentials"
          || adapterCommand.payload.mode === "repair_employee_credentials") {
          if (!adapter.inspectEmployeeCredentials) throw new Error("Adapter does not support credential verification");
          if (!adapterCommand.employee_id) throw new Error("employee_id is required for credential verification");
          const employeeNo = String(adapterCommand.payload.employee_no ?? "");
          const snapshot = await adapter.inspectEmployeeCredentials(employeeNo);
          await reconcileEmployeeSnapshot(adapterCommand, device, snapshot);
          const repairJobs = adapterCommand.payload.mode === "repair_employee_credentials"
            ? await enqueueCredentialRepairs(adapterCommand, device, snapshot) : [];
          return { credentialType: "verification", snapshot, repairJobs };
        }
        if (!("searchPeople" in adapter)) throw new Error("Adapter does not support person search");
        {
          const people = await (adapter as DeviceAdapter & { searchPeople(): Promise<Record<string, unknown>[]> }).searchPeople();
          const upserted = await importPeople(device, people, adapterCommand);
          await supabase.from("device_sync_logs").insert({
            device_id: device.id, command_id: adapterCommand.id, sync_type: "people", status: "success",
            records_found: people.length, records_upserted: upserted, started_at: new Date().toISOString(), completed_at: new Date().toISOString()
          });
        }
        break;
      case "delete_person":
        await adapter.deletePerson(adapterCommand);
        break;
      case "sync_card":
        await adapter.syncCard(adapterCommand);
        break;
      case "delete_card":
        if (!("deleteCard" in adapter)) throw new Error("Adapter does not support delete_card");
        await (adapter as DeviceAdapter & { deleteCard(command: DeviceCommand): Promise<void> }).deleteCard(adapterCommand);
        break;
      case "sync_face":
        await adapter.syncFace(adapterCommand);
        break;
      case "delete_face":
        if (!("deleteFace" in adapter)) throw new Error("Adapter does not support delete_face");
        await (adapter as DeviceAdapter & { deleteFace(command: DeviceCommand): Promise<void> }).deleteFace(adapterCommand);
        break;
      case "enroll_fingerprint":
        return adapter.requestFingerprintEnrollment(adapterCommand);
      case "delete_fingerprint":
        if (!("deleteFingerprint" in adapter)) throw new Error("Adapter does not support delete_fingerprint");
        await (adapter as DeviceAdapter & { deleteFingerprint(command: DeviceCommand): Promise<void> }).deleteFingerprint(adapterCommand);
        break;
      case "remote_door":
        if (!("remoteDoor" in adapter)) throw new Error("Adapter does not support remote_door");
        await (adapter as DeviceAdapter & { remoteDoor(command: DeviceCommand): Promise<void> }).remoteDoor(adapterCommand);
        break;
      case "sync_permission_schedule":
        if (!("syncPermissionSchedule" in adapter)) throw new Error("Adapter does not support sync_permission_schedule");
        await (adapter as DeviceAdapter & { syncPermissionSchedule(command: DeviceCommand): Promise<void> }).syncPermissionSchedule(adapterCommand);
        break;
      case "reboot":
        await adapter.rebootDevice(adapterCommand);
        break;
      case "sync_time":
        await adapter.syncTime(adapterCommand);
        break;
      default:
        throw new Error(`Unsupported command type: ${adapterCommand.command_type}`);
    }
  } finally {
    await adapter.disconnect();
  }
}

async function replicateFingerprint(command: DeviceCommand, destination: DeviceRecord): Promise<FingerprintEnrollmentResult> {
  const employeeNo = String(command.payload.employee_no ?? "").trim();
  const requestedFingerNos = Array.isArray(command.payload.finger_nos)
    ? command.payload.finger_nos.map(Number)
    : [Number(command.payload.finger_no)];
  const supportedFingerNos = [...new Set(requestedFingerNos)]
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= 10);
  const maxFingerprints = deviceFingerprintTargetCount(supportedFingerNos.length, destination);
  const fingerNos = supportedFingerNos.slice(0, maxFingerprints);
  const fingerNo = fingerNos[0];
  const sourceDeviceId = String(command.payload.source_device_id ?? "");
  if (!command.employee_id) throw new Error("employee_id is required for fingerprint replication");
  if (!fingerNos.length) throw new Error("HIKVISION_FINGER_NO_INVALID");
  if (!sourceDeviceId || sourceDeviceId === destination.id) throw new Error("HIKVISION_FINGERPRINT_SOURCE_REQUIRED");

  const { data: source, error } = await supabase.from("devices")
    .select("id,branch_id,name,protocol,device_identifier,serial_number,dev_index,metadata,status")
    .eq("id", sourceDeviceId).single();
  if (error) throw error;
  if (source.status === "offline") throw new Error("HIKVISION_FINGERPRINT_SOURCE_OFFLINE");

  const sourceAdapter = createAdapter(source as DeviceRecord);
  const destinationAdapter = createAdapter(destination);
  if (!sourceAdapter.downloadFingerprintTemplate || !destinationAdapter.addFingerprintTemplate) {
    throw new Error("HIKVISION_FINGERPRINT_REPLICATION_UNSUPPORTED: capture is required on this device");
  }

  await sourceAdapter.connect();
  try {
    await destinationAdapter.connect();
    try {
      const initialSnapshot = destinationAdapter.inspectEmployeeCredentials
        ? await destinationAdapter.inspectEmployeeCredentials(employeeNo) : null;
      if (initialSnapshot && !initialSnapshot.person) {
        throw new Error("HIKVISION_PERSON_REQUIRED: synchronize the person before fingerprint replication");
      }
      for (const currentFingerNo of fingerNos) {
        const template = await sourceAdapter.downloadFingerprintTemplate(employeeNo, currentFingerNo);
        try {
          await destinationAdapter.addFingerprintTemplate(employeeNo, currentFingerNo, template);
        } finally {
          // Each source template becomes unreachable before the next iteration.
        }
      }
      const verifiedFingerNos: number[] = [];
      if (!destinationAdapter.downloadFingerprintTemplate) {
        throw new Error("HIKVISION_FINGERPRINT_POST_VERIFY_UNSUPPORTED");
      }
      for (const currentFingerNo of fingerNos) {
        try {
          const verifiedTemplate = await destinationAdapter.downloadFingerprintTemplate(employeeNo, currentFingerNo);
          if (verifiedTemplate.fingerData) verifiedFingerNos.push(currentFingerNo);
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("HIKVISION_FINGERPRINT_NOT_FOUND")) throw error;
        }
      }
      const finalSnapshot = destinationAdapter.inspectEmployeeCredentials
        ? await destinationAdapter.inspectEmployeeCredentials(employeeNo) : null;
      const verifiedCount = finalSnapshot?.fingerprintCount ?? verifiedFingerNos.length;
      await recordCredentialState(command.employee_id, destination.id, "fingerprint", verifiedCount > 0 ? "synced" : "failed",
        command.id, traceIdFor(command), verifiedFingerNos.length === fingerNos.length ? null : "HIKVISION_FINGERPRINT_REPLICATION_PARTIAL",
        verifiedCount, {
          source_device_id: sourceDeviceId, requested_finger_nos: fingerNos,
          verified_finger_nos: verifiedFingerNos
        });
      if (verifiedFingerNos.length !== fingerNos.length) {
        throw new Error(`HIKVISION_FINGERPRINT_REPLICATION_PARTIAL: requested ${fingerNos.join(",")}; verified ${verifiedFingerNos.join(",") || "none"}`);
      }
      return {
        credentialType: "fingerprint", fingerNo, fingerNos, verifiedFingerNos, verifiedCount,
        materialization: "synced", sourceDeviceId,
        operations: ["FingerPrintUpload", "FingerPrintDownload", "AddFingerPrint", "verify_employee_credentials"]
      };
    } finally {
      // The template is held only by this stack frame and is never logged or persisted.
      await destinationAdapter.disconnect();
    }
  } finally {
    await sourceAdapter.disconnect();
  }
}

async function reconcileEmployeeSnapshot(command: DeviceCommand, device: DeviceRecord, snapshot: EmployeeCredentialSnapshot) {
  if (!command.employee_id) return;
  const traceId = traceIdFor(command);
  const { data: employee, error } = await supabase.from("employees")
    .select("id,hikvision_employee_no,hikvision_is_admin,card_number,fingerprint_count").eq("id", command.employee_id).single();
  if (error) throw error;
  const expectedEmployeeNo = String(employee.hikvision_employee_no);
  const personMatches = snapshot.person?.employeeNo === expectedEmployeeNo;
  const roleMatches = Boolean(snapshot.person)
    && snapshot.person?.localUIRight === Boolean(employee.hikvision_is_admin);
  const expectedCard = String(employee.card_number ?? "").trim();
  const cardMatches = expectedCard ? snapshot.cardNumbers.includes(expectedCard) : snapshot.cardNumbers.length === 0;
  const canonicalFingerprintCount = Number(employee.fingerprint_count ?? 0);
  const expectedFingerprintCount = deviceFingerprintTargetCount(canonicalFingerprintCount, device);
  const fingerprintMatches = expectedFingerprintCount === 0
    ? snapshot.fingerprintCount === 0
    : snapshot.fingerprintCount >= expectedFingerprintCount;
  const verifiedAtMetadata = { source: "DeviceGateway credential verification" };

  await recordCredentialState(command.employee_id, device.id, "person", personMatches ? "synced" : "failed",
    command.id, traceId, personMatches ? null : "HIKVISION_PERSON_NOT_FOUND_ON_DEVICE",
    personMatches ? 1 : 0, verifiedAtMetadata);
  await recordCredentialState(command.employee_id, device.id, "role", roleMatches ? "synced" : "failed",
    command.id, traceId, roleMatches ? null : "HIKVISION_DEVICE_ROLE_MISMATCH",
    roleMatches ? 1 : 0, {
      ...verifiedAtMetadata,
      expected_admin: Boolean(employee.hikvision_is_admin),
      actual_admin: snapshot.person?.localUIRight ?? null
    });
  await recordCredentialState(command.employee_id, device.id, "card",
    expectedCard ? cardMatches ? "synced" : "failed" : "none",
    command.id, traceId, expectedCard && !cardMatches ? "HIKVISION_CARD_NOT_FOUND_ON_DEVICE" : null,
    cardMatches && expectedCard ? 1 : 0, { ...verifiedAtMetadata, expected: Boolean(expectedCard) });
  await recordCredentialState(command.employee_id, device.id, "fingerprint",
    expectedFingerprintCount === 0 ? "none" : fingerprintMatches ? "synced" : "failed",
    command.id, traceId, fingerprintMatches || expectedFingerprintCount === 0 ? null
      : `HIKVISION_FINGERPRINT_COUNT_MISMATCH: expected ${expectedFingerprintCount}; actual ${snapshot.fingerprintCount}`,
    snapshot.fingerprintCount, {
      ...verifiedAtMetadata,
      canonical_count: canonicalFingerprintCount,
      expected_count: expectedFingerprintCount,
      device_target_count: expectedFingerprintCount,
      actual_count: snapshot.fingerprintCount,
      device_limited: expectedFingerprintCount < canonicalFingerprintCount,
      limitation: expectedFingerprintCount < canonicalFingerprintCount
        ? "Este equipo conserva una huella por persona mediante la API instalada." : null
    });
  await recordCredentialState(command.employee_id, device.id, "face",
    snapshot.faceCount > 0 ? "synced" : "none",
    command.id, traceId, null, snapshot.faceCount, verifiedAtMetadata);

  await supabase.from("employee_devices").update({
    external_person_id: snapshot.person?.employeeNo ?? expectedEmployeeNo,
    sync_status: personMatches && roleMatches ? "success" : "failed",
    last_attempt_at: new Date().toISOString(),
    last_synced_at: personMatches && roleMatches ? new Date().toISOString() : undefined,
    last_error: !personMatches ? "HIKVISION_PERSON_NOT_FOUND_ON_DEVICE"
      : !roleMatches ? "HIKVISION_DEVICE_ROLE_MISMATCH" : null
  }).eq("employee_id", command.employee_id).eq("device_id", device.id);
}

async function enqueueCredentialRepairs(command: DeviceCommand, device: DeviceRecord, snapshot: EmployeeCredentialSnapshot) {
  if (!command.employee_id) return [];
  const { data: employee, error } = await supabase.from("employees")
    .select("id,full_name,hikvision_employee_no,hikvision_is_admin,card_number,fingerprint_count,access_valid_from,access_valid_to")
    .eq("id", command.employee_id).single();
  if (error) throw error;
  const employeeNo = String(employee.hikvision_employee_no);
  const traceId = traceIdFor(command);
  const jobs: string[] = [];
  let personCommandId: string | null = null;
  const personMissing = !snapshot.person || snapshot.person.employeeNo !== employeeNo;
  const personChanged = Boolean(snapshot.person) && snapshot.person?.name.trim() !== String(employee.full_name).trim();
  const roleChanged = Boolean(snapshot.person)
    && snapshot.person?.localUIRight !== Boolean(employee.hikvision_is_admin);

  if (personMissing || personChanged || roleChanged) {
    const queued = await enqueueRepairCommand({
      deviceId: device.id, employeeId: command.employee_id,
      commandType: personMissing ? "sync_person" : "update_person",
      requestedBy: command.requested_by,
      payload: {
        employee_no: employeeNo, name: employee.full_name,
        local_ui_right: Boolean(employee.hikvision_is_admin),
        valid_from: `${employee.access_valid_from ?? "2020-01-01"}T00:00:00`,
        valid_to: `${employee.access_valid_to ?? "2037-12-31"}T23:59:59`,
        trace_id: traceId, reconciliation_command_id: command.id
      }
    });
    personCommandId = queued;
    if (queued) jobs.push(queued);
  }

  const expectedCard = String(employee.card_number ?? "").trim();
  if (expectedCard && !snapshot.cardNumbers.includes(expectedCard)) {
    const queued = await enqueueRepairCommand({
      deviceId: device.id, employeeId: command.employee_id, commandType: "sync_card",
      requestedBy: command.requested_by, dependsOn: personCommandId,
      payload: {
        employee_no: employeeNo, card_no: expectedCard,
        trace_id: traceId, reconciliation_command_id: command.id
      }
    });
    if (queued) jobs.push(queued);
  }

  const targetFingerprintCount = deviceFingerprintTargetCount(
    Number(employee.fingerprint_count ?? 0), device
  );
  if (snapshot.fingerprintCount < targetFingerprintCount) {
    const { data: deterministicFailure, error: deterministicFailureError } = await supabase.from("device_commands")
      .select("id,error_code").eq("employee_id", command.employee_id).eq("device_id", device.id)
      .eq("command_type", "enroll_fingerprint").eq("status", "failed")
      .eq("resolution_status", "active").in("error_code", [
        "HIKVISION_FINGERPRINT_REPLICATION_PARTIAL",
        "HIKVISION_FINGERPRINT_REPLICATION_UNSUPPORTED",
        "HIKVISION_FINGERPRINT_POST_VERIFY_UNSUPPORTED"
      ]).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (deterministicFailureError) throw deterministicFailureError;
    if (deterministicFailure) {
      await recordCredentialState(command.employee_id, device.id, "fingerprint", "failed",
        deterministicFailure.id, traceId,
        `HIKVISION_FINGERPRINT_REPAIR_BLOCKED: ${deterministicFailure.error_code}`,
        snapshot.fingerprintCount, {
          reason: "deterministic_failure_requires_device_action",
          blocking_command_id: deterministicFailure.id
        });
      return jobs;
    }
    const { data: sources, error: sourceError } = await supabase.from("employee_device_credentials")
      .select("device_id,verified_count,status,metadata,devices:device_id(status)")
      .eq("employee_id", command.employee_id).eq("credential_type", "fingerprint")
      .in("status", ["captured", "synced"]).gt("verified_count", 0)
      .neq("device_id", device.id).order("verified_count", { ascending: false }).limit(10);
    if (sourceError) throw sourceError;
    const source = (sources ?? []).find((item: any) => relation(item.devices)?.status !== "offline");
    if (source) {
      const { data: audits, error: auditError } = await supabase.from("credential_audit_events")
        .select("metadata").eq("employee_id", command.employee_id).eq("device_id", source.device_id)
        .eq("status", "success").in("action", ["CaptureFingerPrint", "AddFingerPrint"])
        .order("created_at", { ascending: false }).limit(20);
      if (auditError) throw auditError;
      const auditedFingerNos = [...new Set((audits ?? [])
        .map((item: any) => Number(item.metadata?.finger_no))
        .filter((value: number) => Number.isInteger(value) && value >= 1 && value <= 10))];
      const candidateFingerNos = auditedFingerNos.length
        ? auditedFingerNos
        : Array.from({ length: Math.min(10, Number(source.verified_count)) }, (_, index) => index + 1);
      const fingerNos = candidateFingerNos
        .sort((left, right) => left - right)
        .slice(0, targetFingerprintCount);
      for (const fingerNo of fingerNos) {
        if (!Number.isInteger(fingerNo)) throw new Error("HIKVISION_FINGER_NO_INVALID");
      }
      const queued = await enqueueRepairCommand({
        deviceId: device.id, employeeId: command.employee_id, commandType: "enroll_fingerprint",
        requestedBy: command.requested_by, dependsOn: personCommandId,
        payload: {
          mode: "replicate", source_device_id: source.device_id, employee_no: employeeNo,
          finger_no: fingerNos[0], finger_nos: fingerNos, trace_id: traceId,
          reconciliation_command_id: command.id
        }
      });
      if (queued) jobs.push(queued);
      await recordCredentialState(command.employee_id, device.id, "fingerprint", "pending",
        command.id, traceId, null, null,
        { reason: "replication_queued", source_device_id: source.device_id, finger_nos: fingerNos });
    } else {
      await recordCredentialState(command.employee_id, device.id, "fingerprint", "pending",
        command.id, traceId, "HIKVISION_FINGERPRINT_CAPTURE_REQUIRED_ON_DEVICE", null,
        { reason: "capture_required_on_this_device" });
    }
  }
  return jobs;
}

async function enqueueRepairCommand(input: {
  deviceId: string;
  employeeId: string;
  commandType: string;
  requestedBy?: string | null;
  dependsOn?: string | null;
  payload: Record<string, unknown>;
}) {
  let active = supabase.from("device_commands").select("id")
    .eq("device_id", input.deviceId).eq("employee_id", input.employeeId)
    .eq("command_type", input.commandType).in("status", ["pending", "processing"]);
  if (input.commandType === "enroll_fingerprint") {
    active = active.contains("payload", {
      mode: "replicate",
      source_device_id: input.payload.source_device_id
    });
  }
  const { data: existing, error: existingError } = await active.limit(1).maybeSingle();
  if (existingError) throw existingError;
  if (existing) return existing.id as string;
  const { data, error } = await supabase.from("device_commands").insert({
    device_id: input.deviceId, employee_id: input.employeeId, command_type: input.commandType,
    requested_by: input.requestedBy ?? null, payload: input.payload,
    depends_on_command_id: input.dependsOn ?? null
  }).select("id").single();
  if (error) throw error;
  return data.id as string;
}

async function importPeople(device: DeviceRecord & { branch_id?: string | null }, people: Record<string, unknown>[], command: DeviceCommand) {
  if (!device.branch_id) throw new Error("Device must be assigned to a branch before importing people");
  const { data: branch, error: branchError } = await supabase.from("branches").select("company_id").eq("id", device.branch_id).single();
  if (branchError) throw branchError;

  let upserted = 0;
  const observedEmployeeNos = new Set<string>();
  for (const person of people) {
    const employeeNo = String(person.employeeNo ?? person.employeeNoString ?? "").trim();
    if (!employeeNo) continue;
    observedEmployeeNos.add(employeeNo);
    const [linkResult, canonicalResult, externalResult] = await Promise.all([
      supabase.from("employee_devices").select("employees:employee_id(id,metadata,card_number)")
        .eq("device_id", device.id).eq("external_person_id", employeeNo).maybeSingle(),
      supabase.from("employees").select("id,metadata,card_number").eq("company_id", branch.company_id)
        .eq("hikvision_employee_no", employeeNo).maybeSingle(),
      supabase.from("employees").select("id,metadata,card_number").eq("company_id", branch.company_id)
        .eq("external_employee_id", employeeNo).maybeSingle()
    ]);
    for (const result of [linkResult, canonicalResult, externalResult]) if (result.error) throw result.error;
    const linked = Array.isArray(linkResult.data?.employees) ? linkResult.data.employees[0] : linkResult.data?.employees;
    const existing = linked ?? canonicalResult.data ?? externalResult.data;
    let employeeId = existing?.id;
    const fingerprintCount = safeCount(person.numOfFP ?? person.fingerPrintNum ?? person.fingerprintCount);
    const faceCount = safeCount(person.numOfFace ?? person.faceNum ?? person.faceCount);
    const cardCount = safeCount(person.numOfCard ?? person.cardNum ?? person.cardCount ?? (person.cardNo ? 1 : 0));
    const cardNumber = typeof person.cardNo === "string" && person.cardNo.trim() ? person.cardNo.trim() : null;
    const credentialStatus = {
      card: cardCount > 0 ? "enrolled" : "none", fingerprint: fingerprintCount > 0 ? "enrolled" : "none",
      face: faceCount > 0 ? "enrolled" : "none", pin: "unknown"
    };
    if (employeeId) {
      const { error } = await supabase.from("employees").update({
        full_name: String(person.name ?? employeeNo).trim() || employeeNo,
        card_number: cardNumber ?? undefined,
        metadata: { ...(existing?.metadata ?? {}), source: "devicegateway", devicegateway_last_import_at: new Date().toISOString(),
          devicegateway_counts_by_device: { ...((existing?.metadata as any)?.devicegateway_counts_by_device ?? {}),
            [device.id]: { cards: cardCount, fingerprints: fingerprintCount, faces: faceCount, verified_at: new Date().toISOString() } } }
      }).eq("id", employeeId);
      if (error) throw error;
    } else {
      const fullName = String(person.name ?? employeeNo).trim() || employeeNo;
      const hikvisionEmployeeNo = /^\d+$/.test(employeeNo)
        ? employeeNo
        : await allocateHikvisionEmployeeNo(branch.company_id);
      const { data: created, error } = await supabase.from("employees").insert({
        company_id: branch.company_id,
        branch_id: device.branch_id,
        employee_code: employeeNo,
        external_employee_id: employeeNo,
        hikvision_employee_no: hikvisionEmployeeNo,
        full_name: fullName,
        card_number: cardNumber,
        fingerprint_count: fingerprintCount,
        fingerprint_status: fingerprintCount > 0 ? "enrolled" : "none",
        face_status: faceCount > 0 ? "enrolled" : "none",
        credential_status: credentialStatus,
        metadata: { source: "devicegateway", devicegateway_last_import_at: new Date().toISOString(),
          devicegateway_counts: { cards: cardCount, fingerprints: fingerprintCount, faces: faceCount } }
      }).select("id").single();
      if (error) throw error;
      employeeId = created.id;
    }
    const { error: linkError } = await supabase.from("employee_devices").upsert({
      employee_id: employeeId,
      device_id: device.id,
      external_person_id: employeeNo,
      sync_status: "success",
      last_synced_at: new Date().toISOString(),
      last_error: null
    }, { onConflict: "employee_id,device_id" });
    if (linkError) throw linkError;
    const traceId = traceIdFor({ id: command.id, payload: command.payload });
    await recordCredentialState(employeeId, device.id, "person", "synced", command.id, traceId, null, 1);
    await recordCredentialState(employeeId, device.id, "card", cardCount > 0 ? "synced" : existing?.card_number ? "pending" : "none",
      command.id, traceId, null, cardCount);
    await recordCredentialState(employeeId, device.id, "fingerprint", fingerprintCount > 0 ? "captured" : "none",
      command.id, traceId, null, fingerprintCount, { source: "DeviceGateway UserInfo/Search" });
    await recordCredentialState(employeeId, device.id, "face", faceCount > 0 ? "synced" : "none",
      command.id, traceId, null, faceCount, { source: "DeviceGateway UserInfo/Search" });
    upserted += 1;
  }
  await reconcileMissingDeviceAssignments(device, command, observedEmployeeNos);
  return upserted;
}

const safeCount = (value: unknown) => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
const relation = (value: any) => Array.isArray(value) ? value[0] : value;

function deviceFingerprintTargetCount(canonicalCount: number, device: DeviceRecord) {
  const configuredLimit = Number(
    (device.metadata?.credential_capabilities as Record<string, unknown> | undefined)
      ?.max_fingerprints_per_person
  );
  if (!Number.isInteger(configuredLimit) || configuredLimit < 1 || configuredLimit > 10) {
    return canonicalCount;
  }
  return Math.min(canonicalCount, configuredLimit);
}

async function reconcileMissingDeviceAssignments(device: DeviceRecord, command: DeviceCommand, observedEmployeeNos: Set<string>) {
  const { data: links, error } = await supabase.from("employee_devices")
    .select("employee_id,external_person_id,employees:employee_id(hikvision_employee_no,card_number)")
    .eq("device_id", device.id);
  if (error) throw error;
  const traceId = traceIdFor(command);
  for (const link of links ?? []) {
    const employee = relation(link.employees);
    const expectedNo = String(employee?.hikvision_employee_no ?? link.external_person_id ?? "");
    if (!expectedNo || observedEmployeeNos.has(expectedNo) || observedEmployeeNos.has(String(link.external_person_id ?? ""))) continue;
    await supabase.from("employee_devices").update({
      sync_status: "failed", last_attempt_at: new Date().toISOString(),
      last_error: "HIKVISION_PERSON_NOT_FOUND_ON_DEVICE"
    }).eq("employee_id", link.employee_id).eq("device_id", device.id);
    await recordCredentialState(link.employee_id, device.id, "person", "failed",
      command.id, traceId, "HIKVISION_PERSON_NOT_FOUND_ON_DEVICE", 0,
      { source: "DeviceGateway full reconciliation" });
    await recordCredentialState(link.employee_id, device.id, "card",
      employee?.card_number ? "failed" : "none", command.id, traceId,
      employee?.card_number ? "HIKVISION_CARD_NOT_FOUND_ON_DEVICE" : null, 0,
      { source: "DeviceGateway full reconciliation" });
    await recordCredentialState(link.employee_id, device.id, "fingerprint", "none",
      command.id, traceId, null, 0, { source: "DeviceGateway full reconciliation" });
  }
}

export async function runCommandWorkerOnce() {
  if (running) return;
  running = true;

  try {
    const { data: expiredSessions, error: expiredError } = await supabase.from("employee_creation_sessions")
      .select("id").in("status", ["draft", "enrolling", "captured"]).lt("expires_at", new Date().toISOString()).limit(20);
    if (expiredError) throw expiredError;
    for (const session of expiredSessions ?? []) {
      const { error: cleanupError } = await supabase.rpc("admin_cancel_employee_creation_session", {
        p_session_id: session.id, p_requested_by: null, p_reason: "expired"
      });
      if (cleanupError) logger.error({ err: cleanupError, creationSessionId: session.id }, "Expired employee creation cleanup failed");
    }
    await supabase.from("biometric_enrollment_sessions").update({
      status: "timeout", completed_at: new Date().toISOString(), error_message: "Fingerprint capture timed out"
    }).in("status", ["pending", "processing"]).lt("created_at", new Date(Date.now() - 2 * 60 * 1000).toISOString());
    const { data: commands, error } = await supabase
      .from("device_commands")
          .select("*, devices:device_id(id, branch_id, name, protocol, device_identifier, serial_number, dev_index, metadata)")
      .eq("status", "pending")
      .lte("next_run_at", new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(10);

    if (error) throw error;

    for (const command of commands ?? []) {
      if (command.depends_on_command_id) {
        const { data: dependency, error: dependencyError } = await supabase.from("device_commands")
          .select("status,error_message").eq("id", command.depends_on_command_id).maybeSingle();
        if (dependencyError) throw dependencyError;
        if (!dependency || ["failed", "cancelled"].includes(dependency.status)) {
          const dependencyMessage = dependency?.error_message || "Required preparation job was not available";
          await supabase.from("device_commands").update({ status: "failed", processed_at: new Date().toISOString(),
            error_message: `Preparation failed: ${dependencyMessage}` }).eq("id", command.id).eq("status", "pending");
          if (command.command_type === "enroll_fingerprint" && command.payload?.session_id) {
            await supabase.from("biometric_enrollment_sessions").update({ status: "failed", completed_at: new Date().toISOString(),
              status_detail: "No se pudo preparar la persona", error_message: dependencyMessage }).eq("id", command.payload.session_id);
            if (command.payload?.creation_session_id) await supabase.from("employee_creation_sessions").update({ status: "failed",
              error_code: "HIKVISION_PERSON_STAGE_FAILED", error_message: dependencyMessage }).eq("id", command.payload.creation_session_id);
          }
          continue;
        }
        if (dependency.status !== "success") continue;
      }
      const attempts = (command.attempts ?? 0) + 1;
      await supabase
        .from("device_commands")
        .update({ status: "processing", attempts, locked_at: new Date().toISOString() })
        .eq("id", command.id)
        .eq("status", "pending");

      try {
        validateCommandPayload(command);
        if (command.employee_id && isPersonCommand(command.command_type)) await setEmployeeDeviceState(command.employee_id, command.device_id, "processing");
        await recordCommandAudit(command, "processing");
        if (command.employee_id) await recordCommandCredentialState(command, "processing");
        if (command.command_type === "enroll_fingerprint" && command.payload?.session_id) {
          await supabase.from("biometric_enrollment_sessions").update({ status: "processing", started_at: new Date().toISOString(),
            worker_started_at: new Date().toISOString(), status_detail: "Worker tomó el trabajo; esperando dispositivo", error_message: null }).eq("id", command.payload.session_id);
          if (command.payload?.creation_session_id) await supabase.from("employee_creation_sessions").update({
            status: "enrolling", error_code: null, error_message: null
          }).eq("id", command.payload.creation_session_id);
        }
        if (command.command_type === "enroll_fingerprint" && command.payload?.session_id) await supabase.from("biometric_enrollment_sessions").update({
          device_request_started_at: new Date().toISOString(), status_detail: "Esperando dedo en el dispositivo"
        }).eq("id", command.payload.session_id);
        const commandResult = await executeCommand(
          {
            id: command.id,
            device_id: command.device_id,
            employee_id: command.employee_id,
            requested_by: command.requested_by,
            command_type: command.command_type,
            payload: command.payload ?? {}
          },
          command.devices as DeviceRecord
        );

        if (commandResult && "errors" in commandResult) {
          await supabase.from("device_commands").update({
            metadata: { ...(command.metadata ?? {}), attendance_sync_result: commandResult }
          }).eq("id", command.id);
          if (commandResult.errors.length > 0) throw new Error(commandResult.errors[0]?.error ?? "Historical sync failed");
        }

        const verifiedFingerprintCount = command.command_type === "enroll_fingerprint"
          && commandResult && "credentialType" in commandResult
          && commandResult.credentialType === "fingerprint"
          && Number.isInteger(commandResult.verifiedCount)
          && commandResult.verifiedCount > 0
          ? commandResult.verifiedCount : null;
        if (command.command_type === "enroll_fingerprint" && !verifiedFingerprintCount) {
          throw new Error("HIKVISION_FINGERPRINT_NOT_VERIFIED: missing post-download verification");
        }

        await supabase
          .from("device_commands")
          .update({
            status: "success", processed_at: new Date().toISOString(), error_message: null,
            error_code: null, resolution_status: "resolved", resolved_at: new Date().toISOString(),
            resolution_reason: "command_succeeded"
          })
          .eq("id", command.id);

        await supabase.from("device_command_logs").insert({
          device_command_id: command.id,
          device_id: command.device_id,
          status: "success",
          message: "Command processed successfully"
        });
        if (command.employee_id && isPersonCommand(command.command_type)) await setEmployeeDeviceState(command.employee_id, command.device_id, "success");
        if (command.employee_id) await recordCommandCredentialState(command, "success", null, commandResult);
        await recordCommandAudit(command, "success", null, commandResult);
        await markDeviceOnline(command.device_id);
        await resolveSupersededFailures(command);
        if (command.command_type === "enroll_fingerprint" && command.payload?.session_id) {
          await supabase.from("biometric_enrollment_sessions").update({ status: "success", completed_at: new Date().toISOString(),
            device_response_at: new Date().toISOString(), status_detail: `Huella verificada en el dispositivo (${verifiedFingerprintCount})`,
            verified_count: verifiedFingerprintCount, error_message: null }).eq("id", command.payload.session_id);
          if (command.payload?.creation_session_id) {
            await supabase.from("employee_creation_sessions").update({ status: "captured", error_code: null, error_message: null }).eq("id", command.payload.creation_session_id);
          } else if (command.employee_id) {
            if (command.payload?.previous_employee_no) {
              await supabase.from("employee_devices").update({
                external_person_id: String(command.payload.employee_no), sync_status: "success", last_error: null,
                last_synced_at: new Date().toISOString()
              }).eq("employee_id", command.employee_id).eq("device_id", command.device_id);
              await enqueueIdentifierCleanup(command, String(command.payload.previous_employee_no));
            }
          }
        }
      } catch (error) {
        const safeError = sanitizeCommandError(error);
        const errorCode = commandErrorCode(safeError);
        const deviceOffline = errorCode === "HIKVISION_DEVICE_OFFLINE";
        const interactiveEnrollment = command.command_type === "enroll_fingerprint"
          && command.payload?.mode !== "replicate";
        const deterministicFingerprintFailure = isDeterministicFingerprintFailure(errorCode);
        const shouldRetry = deviceOffline
          || (!deterministicFingerprintFailure && command.command_type !== "fetch_events" && !interactiveEnrollment
            && attempts < (command.max_attempts ?? 5));
        const backoffSeconds = deviceOffline
          ? Math.min(3600, Math.max(300, 2 ** Math.min(attempts, 8) * 30))
          : Math.min(300, 2 ** attempts * 5);
        await supabase
          .from("device_commands")
          .update({
            status: shouldRetry ? "pending" : "failed",
            next_run_at: new Date(Date.now() + backoffSeconds * 1000).toISOString(),
            processed_at: shouldRetry ? null : new Date().toISOString(),
            locked_at: null,
            error_message: safeError,
            error_code: errorCode,
            resolution_status: "active",
            resolved_at: null,
            resolution_reason: null,
            metadata: {
              ...(command.metadata ?? {}),
              retry_reason: deviceOffline ? "device_offline" : shouldRetry ? "transient_failure" : undefined,
              last_trace_id: traceIdFor(command)
            }
          })
          .eq("id", command.id);
        if (deviceOffline) await markDeviceOffline(command.device_id, safeError, traceIdFor(command));

        await supabase.from("device_command_logs").insert({
          device_command_id: command.id,
          device_id: command.device_id,
          status: shouldRetry ? "pending" : "failed",
          message: safeError
        });
        if (command.employee_id && isPersonCommand(command.command_type)) await setEmployeeDeviceState(command.employee_id, command.device_id, shouldRetry ? "pending" : "failed", safeError);
        if (command.employee_id) await recordCommandCredentialState(command, shouldRetry ? "pending" : "failed", safeError);
        await recordCommandAudit(command, shouldRetry ? "pending" : "failed", safeError);
        if (!shouldRetry && command.command_type === "enroll_fingerprint" && command.payload?.session_id) {
          await supabase.from("biometric_enrollment_sessions").update({ status: "failed", completed_at: new Date().toISOString(),
            device_response_at: new Date().toISOString(), status_detail: "Fallo de captura", error_message: safeError }).eq("id", command.payload.session_id);
          if (command.payload?.creation_session_id) await supabase.from("employee_creation_sessions").update({
            status: "failed", error_code: "HIKVISION_ENROLLMENT_FAILED", error_message: safeError
          }).eq("id", command.payload.creation_session_id);
          else if (command.employee_id) {
            if (command.payload?.previous_employee_no) await enqueueIdentifierCleanup(command, String(command.payload.employee_no));
          }
        } else if (shouldRetry && command.command_type === "enroll_fingerprint" && command.payload?.session_id) {
          await supabase.from("biometric_enrollment_sessions").update({ status_detail: `Reintento ${attempts} programado`, error_message: safeError }).eq("id", command.payload.session_id);
        }
        if (!shouldRetry && command.command_type === "sync_device_people") {
          await supabase.from("device_sync_logs").insert({ device_id: command.device_id, command_id: command.id,
            sync_type: "people", status: "failed", error_message: safeError, completed_at: new Date().toISOString() });
        }
      }
    }
  } finally {
    running = false;
  }
}

async function allocateHikvisionEmployeeNo(companyId: string) {
  const { data, error } = await supabase.rpc("allocate_hikvision_employee_no", { p_company_id: companyId });
  if (error) throw error;
  const value = String(data ?? "");
  if (!/^\d+$/.test(value)) throw new Error("HIKVISION_EMPLOYEE_NO_ALLOCATION_FAILED");
  return value;
}

async function enqueueIdentifierCleanup(command: any, employeeNo: string) {
  if (!employeeNo) return;
  const { error } = await supabase.from("device_commands").insert({
    device_id: command.device_id,
    employee_id: command.employee_id ?? null,
    command_type: "delete_person",
    requested_by: command.requested_by ?? null,
    payload: { employee_no: employeeNo, identifier_migration_cleanup: true, trace_id: command.payload?.trace_id }
  });
  if (error && error.code !== "23505") logger.error({ err: error, commandId: command.id, deviceId: command.device_id }, "Identifier cleanup enqueue failed");
}

async function setEmployeeDeviceState(employeeId: string, deviceId: string, status: string, lastError: string | null = null) {
  await supabase.from("employee_devices").update({
    sync_status: status,
    last_attempt_at: new Date().toISOString(),
    last_synced_at: status === "success" ? new Date().toISOString() : undefined,
    last_error: lastError
  }).eq("employee_id", employeeId).eq("device_id", deviceId);
}

async function markDeviceOffline(deviceId: string, message: string, traceId: string) {
  const now = new Date().toISOString();
  await supabase.from("devices").update({
    status: "offline"
  }).eq("id", deviceId);
  await supabase.from("device_status_logs").insert({
    device_id: deviceId, status: "offline", message,
    metadata: { source: "command_worker", trace_id: traceId, detected_at: now }
  });
}

async function markDeviceOnline(deviceId: string) {
  await supabase.from("devices").update({
    status: "online", last_seen_at: new Date().toISOString()
  }).eq("id", deviceId);
}

async function resolveSupersededFailures(command: any) {
  let query = supabase.from("device_commands").select("id")
    .eq("device_id", command.device_id).eq("status", "failed")
    .eq("resolution_status", "active").lt("created_at", command.created_at);
  if (command.command_type === "sync_device_people") query = query.eq("command_type", "sync_device_people");
  else if (command.employee_id) {
    query = query.eq("employee_id", command.employee_id);
    const credentialType = credentialTypeForCommand(command.command_type);
    if (credentialType === "person") query = query.in("command_type", ["sync_person", "update_person"]);
    else if (credentialType === "card") query = query.in("command_type", ["sync_card", "delete_card"]);
    else if (credentialType === "fingerprint") query = query.in("command_type", ["enroll_fingerprint", "delete_fingerprint"]);
    else if (credentialType === "face") query = query.in("command_type", ["sync_face", "delete_face"]);
    else query = query.eq("command_type", command.command_type);
  } else query = query.eq("command_type", command.command_type);
  const { data, error } = await query.limit(100);
  if (error) throw error;
  const ids = (data ?? []).map((item) => item.id);
  if (!ids.length) return;
  const { error: updateError } = await supabase.from("device_commands").update({
    resolution_status: "superseded", resolved_at: new Date().toISOString(),
    resolution_reason: "later_verified_command_succeeded", superseded_by: command.id
  }).in("id", ids);
  if (updateError) throw updateError;
}

function validateCommandPayload(command: any) {
  if (["sync_person", "update_person", "sync_card", "enroll_fingerprint"].includes(command.command_type)) {
    const employeeNo = String(command.payload?.employee_no ?? "").trim();
    if (!employeeNo) throw new Error("HIKVISION_EMPLOYEE_NO_REQUIRED: employee_no is required before creating a DeviceGateway request");
    if (!/^\d+$/.test(employeeNo)) throw new Error("HIKVISION_EMPLOYEE_NO_INVALID: employee_no must contain only digits");
  }
  if (command.command_type === "sync_card" && !String(command.payload?.card_no ?? "").trim()) {
    throw new Error("HIKVISION_CARD_NO_REQUIRED: card_no is required before creating a DeviceGateway request");
  }
  if (command.command_type === "enroll_fingerprint") {
    const fingerNo = Number(command.payload?.finger_no ?? 0);
    if (!Number.isInteger(fingerNo) || fingerNo < 1 || fingerNo > 10) throw new Error("HIKVISION_FINGER_NO_INVALID");
  }
}

function isPersonCommand(commandType: string) {
  return ["sync_person", "update_person"].includes(commandType);
}

function traceIdFor(command: { id: string; payload?: Record<string, unknown> }) {
  const candidate = String(command.payload?.trace_id ?? "");
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate) ? candidate : command.id;
}

function credentialTypeForCommand(commandType: string) {
  if (["sync_person", "update_person", "delete_person"].includes(commandType)) return "person";
  if (["sync_card", "delete_card"].includes(commandType)) return "card";
  if (["enroll_fingerprint", "delete_fingerprint"].includes(commandType)) return "fingerprint";
  if (["sync_face", "delete_face"].includes(commandType)) return "face";
  return null;
}

async function recordCredentialState(employeeId: string, deviceId: string, credentialType: string, status: string,
  commandId: string | null, traceId: string | null, lastError: string | null, verifiedCount: number | null = null,
  metadata: Record<string, unknown> = {}) {
  const { error } = await supabase.rpc("record_employee_device_credential_state", {
    p_employee_id: employeeId, p_device_id: deviceId, p_credential_type: credentialType, p_status: status,
    p_command_id: commandId, p_trace_id: traceId, p_last_error: lastError,
    p_verified_count: verifiedCount, p_metadata: metadata
  });
  if (error) throw error;
}

async function recordCommandCredentialState(command: any, status: string, lastError: string | null = null,
  result?: CommandExecutionResult) {
  const credentialType = credentialTypeForCommand(command.command_type);
  if (!credentialType || !command.employee_id || command.command_type.startsWith("delete_")) return;
  const fingerprintResult = result && "credentialType" in result && result.credentialType === "fingerprint"
    ? result : null;
  const verifiedCount = fingerprintResult ? fingerprintResult.verifiedCount
    : status === "success" && credentialType === "person" ? 1
    : status === "success" && credentialType === "card" ? 1 : null;
  const storedStatus = status === "success"
    ? credentialType === "fingerprint" ? fingerprintResult?.materialization ?? "captured" : "synced"
    : status;
  await recordCredentialState(command.employee_id, command.device_id, credentialType, storedStatus,
    command.id, traceIdFor(command), lastError, verifiedCount,
    credentialType === "fingerprint" ? {
      finger_no: Number(command.payload?.finger_no ?? 1),
      finger_nos: fingerprintResult?.fingerNos ?? command.payload?.finger_nos,
      verified_finger_nos: fingerprintResult?.verifiedFingerNos,
      source_device_id: fingerprintResult?.sourceDeviceId,
      mode: command.payload?.mode
    } : {});
  if (credentialType === "person") {
    await recordCredentialState(command.employee_id, command.device_id, "role", storedStatus,
      command.id, traceIdFor(command), lastError,
      status === "success" ? 1 : null, {
        expected_admin: command.payload?.local_ui_right === true,
        actual_admin: status === "success" ? command.payload?.local_ui_right === true : undefined
      });
  }
}

async function recordCommandAudit(command: any, status: string, sanitizedError: string | null = null,
  result?: CommandExecutionResult) {
  const credentialType = credentialTypeForCommand(command.command_type)
    ?? (command.command_type === "sync_device_people" && command.employee_id ? "verification" : null);
  if (!credentialType) return;
  const base = {
    employee_id: command.employee_id ?? null, creation_session_id: command.payload?.creation_session_id ?? null,
    device_id: command.device_id, command_id: command.id, status,
    trace_id: traceIdFor(command), sanitized_error: sanitizedError,
    metadata: {
      credential_type: credentialType, finger_no: command.payload?.finger_no ?? undefined,
      finger_nos: command.payload?.finger_nos ?? undefined,
      source_device_id: command.payload?.source_device_id ?? undefined,
      destination_device_id: command.device_id,
      mode: command.payload?.mode ?? undefined
    }
  };
  const actions = command.command_type === "enroll_fingerprint" && status === "success" && result && "operations" in result
    ? result.operations
    : [command.command_type === "enroll_fingerprint" && command.payload?.mode === "replicate"
      ? "replicate_fingerprint" : auditAction(command.command_type, sanitizedError)];
  const { error } = await supabase.from("credential_audit_events").insert(actions.map((action) => ({ ...base, action })));
  if (error) throw error;
}

function auditAction(commandType: string, error: string | null) {
  if (commandType === "sync_device_people") return "verify_employee_credentials";
  if (commandType === "enroll_fingerprint") return error?.includes("FingerPrintDownload") ? "FingerPrintDownload" : "CaptureFingerPrint";
  if (commandType === "sync_person" || commandType === "update_person") return "sync_person";
  if (commandType === "sync_card") return "sync_card";
  if (commandType === "delete_person") return "delete_person";
  if (commandType === "delete_card") return "delete_card";
  if (commandType === "delete_fingerprint") return "delete_fingerprint";
  return commandType;
}

export function startCommandWorker() {
  void runCommandWorkerOnce().catch((error) => logger.error({ err: error }, "Command worker failed"));
  setInterval(() => {
    void runCommandWorkerOnce().catch((error) => logger.error({ err: error }, "Command worker failed"));
  }, config.COMMAND_WORKER_INTERVAL_MS);
}
