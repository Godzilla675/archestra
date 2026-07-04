import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  KbChunkModel,
  KbDocumentModel,
  KnowledgeBaseConnectorModel,
} from "@/models";
import { taskQueueService } from "@/task-queue";
import type { AclEntry } from "@/types";
import type { UpstreamPermissions } from "./acl-materializer";
import { AclMaterializer } from "./acl-materializer";
import { IdentityResolutionService } from "./identity-resolution";

/**
 * Compare two ACL arrays order-independently. ACL entries produced by the
 * materializer are always sorted, but stale rows in the DB may not be, so a
 * canonical (sorted, joined) comparison makes "no change" detection reliable
 * and avoids needless rewrites + WAL churn. Accepts plain `string[]` because
 * the DB-typed column is `string[]`, while the materializer returns the
 * narrower `AclEntry[]`; both are compatible here.
 */
function isSameAcl(current: string[] | null, next: string[]): boolean {
  const currentSorted = [...(current ?? [])].sort();
  const nextSorted = [...next].sort();
  return (
    currentSorted.length === nextSorted.length &&
    currentSorted.every((v, i) => v === nextSorted[i])
  );
}

/**
 * Re-run the ACL materializer for every document of an auto-sync-permissions
 * connector, applying the cached `rawPermissions` against the *current* set of
 * team external-group mappings. Documents whose materialized ACL would not
 * change are left untouched.
 *
 * Safe to call in a background task: nothing here reads from mutable request
 * state and every DB write is per-document.
 */
export async function recomputeConnectorPermissions(
  connectorId: string,
): Promise<void> {
  const connector = await KnowledgeBaseConnectorModel.findById(connectorId);
  if (connector?.visibility !== "auto-sync-permissions") {
    return;
  }

  const documents = await KbDocumentModel.findAllByConnector(connectorId);
  const materializer = new AclMaterializer(
    new IdentityResolutionService(connector.organizationId),
  );

  for (const doc of documents) {
    // Skip documents that were never synced (null status means auto-sync is
    // not managing this document — e.g. it predates the feature, or the
    // connector was previously org-wide / team-scoped).
    if (doc.permissionSyncStatus === null) {
      continue;
    }

    const metadata = doc.permissionSyncMetadata as {
      provider: string;
      rawPermissions?: UpstreamPermissions;
      resolvedEmails?: string[];
      skippedGroups?: string[];
      lastSyncedAt?: string;
    } | null;
    if (!metadata?.rawPermissions) {
      continue;
    }

    const resolved = await materializer.materialize(metadata.rawPermissions);
    const nextStatus = resolved.complete
      ? ("synced" as const)
      : ("skipped_unresolvable" as const);
    const nextAcl: AclEntry[] = resolved.complete ? resolved.acl : [];

    const aclChanged = !isSameAcl(doc.acl, nextAcl);
    const statusChanged = doc.permissionSyncStatus !== nextStatus;
    if (!aclChanged && !statusChanged) {
      continue;
    }

    const nextMetadata = {
      provider: metadata.provider,
      rawPermissions: metadata.rawPermissions as unknown as Record<
        string,
        unknown
      >,
      resolvedEmails: resolved.resolvedEmails,
      skippedGroups: resolved.skippedGroups,
      lastSyncedAt: new Date().toISOString(),
    };

    await KbDocumentModel.update(doc.id, {
      acl: nextAcl,
      permissionSyncStatus: nextStatus,
      permissionSyncMetadata: nextMetadata,
    });

    await KbChunkModel.updateAclByDocument(doc.id, nextAcl);
  }
}

/**
 * Enqueue a background `connector_permission_recompute` task for every
 * auto-sync-permissions connector in the org. Called from team routes on
 * membership / external-group changes so the request path stays fast — the
 * recomputation itself happens asynchronously in the task queue.
 *
 * Idempotent: re-enqueuing a connector that already has a pending recompute
 * task would create duplicates, but the task handler is safe to run multiple
 * times (recomputation is purely a re-materialization of cached state). A
 * per-org dedupe can be added later if churn becomes an issue.
 */
export async function handleTeamOrGroupMappingChange(
  organizationId: string,
): Promise<void> {
  // Single query: select id + visibility for every connector in the org so we
  // can filter in JS without re-fetching each connector individually.
  const connectors = await db
    .select({
      id: schema.knowledgeBaseConnectorsTable.id,
      visibility: schema.knowledgeBaseConnectorsTable.visibility,
    })
    .from(schema.knowledgeBaseConnectorsTable)
    .where(
      eq(schema.knowledgeBaseConnectorsTable.organizationId, organizationId),
    );

  for (const connector of connectors) {
    if (connector.visibility !== "auto-sync-permissions") continue;

    await taskQueueService.enqueue({
      taskType: "connector_permission_recompute",
      payload: { connectorId: connector.id },
      maxAttempts: 3,
    });
  }
}
