import { recomputeConnectorPermissions } from "@/knowledge-base/recomputation";
import logger from "@/logging";

/**
 * Background handler for `connector_permission_recompute` tasks.
 *
 * Re-runs the ACL materializer for every document of an auto-sync-permissions
 * connector against the current set of team external-group mappings, so that
 * team membership or group-mapping changes are reflected in document ACLs
 * without blocking the team route that triggered the change.
 */
export async function handleConnectorPermissionRecompute(
  payload: Record<string, unknown>,
): Promise<void> {
  const connectorId = payload.connectorId as string;
  if (!connectorId) {
    throw new Error(
      "Missing connectorId in connector_permission_recompute payload",
    );
  }

  logger.info(
    { connectorId },
    "Starting background task handler for permission recompute",
  );
  await recomputeConnectorPermissions(connectorId);
  logger.info(
    { connectorId },
    "Completed background task handler for permission recompute",
  );
}
