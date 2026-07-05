import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mockRecompute = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/knowledge-base/recomputation", () => ({
  recomputeConnectorPermissions: mockRecompute,
}));

vi.mock("@/logging", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { handleConnectorPermissionRecompute } from "./connector-permission-recompute-handler";

describe("handleConnectorPermissionRecompute", () => {
  let connectorId: string;

  beforeEach(() => {
    connectorId = randomUUID();
    vi.clearAllMocks();
  });

  test("calls recomputeConnectorPermissions with the connector ID", async () => {
    await handleConnectorPermissionRecompute({ connectorId });

    expect(mockRecompute).toHaveBeenCalledWith(connectorId);
    expect(mockRecompute).toHaveBeenCalledTimes(1);
  });

  test("throws when connectorId is missing", async () => {
    await expect(
      handleConnectorPermissionRecompute({}),
    ).rejects.toThrow(
      "Missing connectorId in connector_permission_recompute payload",
    );

    expect(mockRecompute).not.toHaveBeenCalled();
  });

  test("propagates errors from recomputeConnectorPermissions", async () => {
    mockRecompute.mockRejectedValueOnce(new Error("connector not found"));

    await expect(
      handleConnectorPermissionRecompute({ connectorId }),
    ).rejects.toThrow("connector not found");
  });
});
