import { useState } from "react";
import { Alert, Button, LinearProgress, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { StatusChip } from "../components/StatusChip";
import { deviceCommandErrorMessage, deviceCommandLabel } from "../lib/deviceCommandMessages";
import { supabase } from "../lib/supabase";

const commandTypes = ["sync_device_people", "sync_person", "update_person", "delete_person", "sync_card", "delete_card", "delete_face", "delete_fingerprint", "remote_door", "sync_permission_schedule", "fetch_events", "reboot", "sync_time"];

export function DeviceCommandsPage() {
  const queryClient = useQueryClient();
  const [deviceId, setDeviceId] = useState("");
  const [commandType, setCommandType] = useState("sync_time");
  const [payload, setPayload] = useState("{}");

  const devices = useQuery({
    queryKey: ["devices-for-commands"],
    queryFn: async () => {
      const { data, error } = await supabase.from("devices").select("id,name,protocol,status").order("name");
      if (error) throw error;
      return data ?? [];
    }
  });

  const commands = useQuery({
    queryKey: ["device-commands"],
    refetchInterval: 5000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("device_commands")
        .select("*, devices:device_id(name)")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data ?? [];
    }
  });

  const createCommand = useMutation({
    mutationFn: async () => {
      const parsedPayload = JSON.parse(payload || "{}");
      const { error } = await supabase.functions.invoke("create-device-command", {
        body: { device_id: deviceId, command_type: commandType, payload: parsedPayload }
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["device-commands"] })
  });

  return (
    <Stack spacing={2}>
      <Typography variant="h5">Cola de comandos</Typography>
      {createCommand.error && <Alert severity="error">{createCommand.error.message}</Alert>}
      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: "column", md: "row" }} spacing={1.5}>
          <TextField select size="small" label="Dispositivo" value={deviceId} onChange={(event) => setDeviceId(event.target.value)} sx={{ minWidth: 240 }}>
            {(devices.data ?? []).map((device) => (
              <MenuItem key={device.id} value={device.id}>{device.name} ({device.protocol})</MenuItem>
            ))}
          </TextField>
          <TextField select size="small" label="Comando" value={commandType} onChange={(event) => setCommandType(event.target.value)} sx={{ minWidth: 220 }}>
            {commandTypes.map((type) => <MenuItem key={type} value={type}>{deviceCommandLabel(type)}</MenuItem>)}
          </TextField>
          <TextField size="small" label="Payload JSON" value={payload} onChange={(event) => setPayload(event.target.value)} sx={{ minWidth: 280 }} />
          <Button variant="contained" onClick={() => createCommand.mutate()} disabled={!deviceId || createCommand.isPending}>Crear</Button>
        </Stack>
      </Paper>
      {commands.isLoading && <LinearProgress />}
      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Creado</TableCell>
              <TableCell>Dispositivo</TableCell>
              <TableCell>Tipo</TableCell>
              <TableCell>Estado</TableCell>
              <TableCell>Intentos</TableCell>
              <TableCell>Error</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(commands.data ?? []).map((command) => (
              <TableRow key={command.id} hover>
                <TableCell>{command.created_at}</TableCell>
                <TableCell>{command.devices?.name ?? command.device_id}</TableCell>
                <TableCell>{deviceCommandLabel(command.command_type)}</TableCell>
                <TableCell><StatusChip value={command.status} /></TableCell>
                <TableCell>{command.attempts}</TableCell>
                <TableCell>{command.error_message ? deviceCommandErrorMessage(command) : ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Stack>
  );
}
