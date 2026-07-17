import { createAdapter } from "../adapters/factory.js";
import type { DeviceAdapter, DeviceCommand, DeviceRecord } from "../adapters/DeviceAdapter.js";
import { logger } from "../logger.js";
import { supabase } from "../supabase.js";

let running = false;

async function executeCommand(adapterCommand: DeviceCommand, device: DeviceRecord) {
  const adapter = createAdapter(device);
  await adapter.connect();
  try {
    switch (adapterCommand.command_type) {
      case "sync_person":
      case "update_person":
        await adapter.syncPerson(adapterCommand);
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
        await adapter.requestFingerprintEnrollment(adapterCommand);
        break;
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
      case "fetch_events":
        await adapter.fetchHistoricalEvents(adapterCommand);
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

export async function runCommandWorkerOnce() {
  if (running) return;
  running = true;

  try {
    const { data: commands, error } = await supabase
      .from("device_commands")
      .select("*, devices:device_id(id, name, protocol, device_identifier, serial_number, dev_index, metadata)")
      .eq("status", "pending")
      .lte("next_run_at", new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(10);

    if (error) throw error;

    for (const command of commands ?? []) {
      const attempts = (command.attempts ?? 0) + 1;
      await supabase
        .from("device_commands")
        .update({ status: "processing", attempts, locked_at: new Date().toISOString() })
        .eq("id", command.id)
        .eq("status", "pending");

      try {
        await executeCommand(
          {
            id: command.id,
            command_type: command.command_type,
            payload: command.payload ?? {}
          },
          command.devices as DeviceRecord
        );

        await supabase
          .from("device_commands")
          .update({ status: "success", processed_at: new Date().toISOString(), error_message: null })
          .eq("id", command.id);

        await supabase.from("device_command_logs").insert({
          device_command_id: command.id,
          device_id: command.device_id,
          status: "success",
          message: "Command processed successfully"
        });
      } catch (error) {
        const shouldRetry = attempts < (command.max_attempts ?? 5);
        const backoffSeconds = Math.min(300, 2 ** attempts * 5);
        await supabase
          .from("device_commands")
          .update({
            status: shouldRetry ? "pending" : "failed",
            next_run_at: new Date(Date.now() + backoffSeconds * 1000).toISOString(),
            error_message: error instanceof Error ? error.message : String(error)
          })
          .eq("id", command.id);

        await supabase.from("device_command_logs").insert({
          device_command_id: command.id,
          device_id: command.device_id,
          status: shouldRetry ? "pending" : "failed",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  } finally {
    running = false;
  }
}

export function startCommandWorker() {
  void runCommandWorkerOnce().catch((error) => logger.error({ err: error }, "Command worker failed"));
  setInterval(() => {
    void runCommandWorkerOnce().catch((error) => logger.error({ err: error }, "Command worker failed"));
  }, 5000);
}
