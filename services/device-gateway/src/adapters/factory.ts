import type { DeviceAdapter, DeviceRecord } from "./DeviceAdapter.js";
import { IsapiHikvisionAdapter } from "./IsapiHikvisionAdapter.js";
import { IsupHikvisionAdapter } from "./IsupHikvisionAdapter.js";
import { MockHikvisionAdapter } from "./MockHikvisionAdapter.js";
import { HikDeviceGatewayAdapter } from "./HikDeviceGatewayAdapter.js";

export function createAdapter(device: DeviceRecord): DeviceAdapter {
  switch (device.protocol) {
    case "mock":
      return new MockHikvisionAdapter(device);
    case "isapi":
      return new IsapiHikvisionAdapter(device);
    case "isup":
      return new IsupHikvisionAdapter(device);
    case "hik_devicegateway":
      return new HikDeviceGatewayAdapter(device);
    case "manual":
      return new MockHikvisionAdapter(device);
    default:
      return new MockHikvisionAdapter(device);
  }
}
