import { eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { TeamModel } from "@/models";
import type { Team } from "@/types";

/**
 * Resolves upstream permission identifiers (user emails, group names) to
 * Archestra member emails within a single organization.
 *
 * Both methods use a small constant number of batched queries
 * (`inArray` / `LOWER(...) IN (...)`) so we never load the entire org roster
 * into memory, and never run an N+1 fan-out over groups / teams.
 */
export class IdentityResolutionService {
  private orgId: string;

  constructor(orgId: string) {
    this.orgId = orgId;
  }

  /**
   * Returns the subset of `emails` that belong to active members of the org.
   * Matching is case-insensitive. The returned strings are the *original*
   * inputs (preserving case and duplicates), so callers that want to show
   * "which of these identities are known" can do so; the ACL materializer
   * lowercases the values itself when building `user_email:*` entries.
   *
   * Matching is case-insensitive via `LOWER(users.email) IN (...)`. This is
   * a single batched query — no full-org roster fetch — though without a
   * `lower(email)` functional index it scans the filtered users subset; for
   * very large orgs a functional index on `lower(email)` is the follow-up.
   */
  async resolveEmailsToMembers(emails: string[]): Promise<string[]> {
    if (emails.length === 0) return [];

    const normalized = [
      ...new Set(
        emails.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0),
      ),
    ];
    if (normalized.length === 0) return [];

    // LOWER(users.email) IN (...) — case-insensitive match against the
    // lowercase inputs. Done against the members-joined-to-users subset that
    // belongs to this org.
    const rows = await db
      .select({ email: schema.usersTable.email })
      .from(schema.membersTable)
      .innerJoin(
        schema.usersTable,
        eq(schema.membersTable.userId, schema.usersTable.id),
      )
      .where(
        sql`LOWER(${schema.usersTable.email}) IN ${sql`(${sql.join(
          normalized.map((e) => sql`${e}`),
          sql`, `,
        )})`}`,
      );

    const activeEmails = new Set(
      rows.map((r) => (r.email ?? "").toLowerCase()),
    );
    // Preserve the caller's input emails (case-sensitive), filtering to those
    // that match a known member. Trailing/leading whitespace is treated as a
    // no-op (we matched against trimmed lowercase), so we return the original.
    return emails.filter(
      (e) => typeof e === "string" && activeEmails.has(e.trim().toLowerCase()),
    );
  }

  /**
   * Resolves group identifiers to the member emails of every Archestra team
   * that maps to each group via `team_external_group`.
   *
   * Uses `TeamModel.findTeamsByExternalGroups` (a single batched query) and a
   * single batched members fetch over the union of team ids — O(2) queries
   * per call instead of O(groups * teams).
   *
   * Groups with no mapping are returned in `unmappedGroups` so callers can
   * apply fail-closed behavior.
   */
  async resolveGroupsToEmails(groupIds: string[]): Promise<{
    resolvedEmails: string[];
    unmappedGroups: string[];
  }> {
    if (groupIds.length === 0) {
      return { resolvedEmails: [], unmappedGroups: [] };
    }

    const normalizedGroups = [...new Set(groupIds.map((g) => g.toLowerCase()))];

    // Single batched query: group -> teams[]
    const groupToTeams = await TeamModel.findTeamsByExternalGroups(
      this.orgId,
      normalizedGroups,
    );

    // `findTeamsByExternalGroups` filters inArray on the normalized (lowercase)
    // input, but keys its returned map by the DB-stored `group_identifier`,
    // which may not be lowercase. Re-key by lowercase to make lookups safe.
    const teamsByLowerGroup = new Map<string, Team[]>();
    for (const [key, value] of groupToTeams.entries()) {
      teamsByLowerGroup.set(key.toLowerCase(), value);
    }

    const unmappedGroups: string[] = [];
    const teamIds = new Set<string>();
    for (const groupId of normalizedGroups) {
      const teams = teamsByLowerGroup.get(groupId) ?? [];
      if (teams.length === 0) {
        unmappedGroups.push(groupId);
        continue;
      }
      for (const team of teams) teamIds.add(team.id);
    }

    if (teamIds.size === 0) {
      return { resolvedEmails: [], unmappedGroups };
    }

    // Single batched query: all members of all those teams
    const rows = await db
      .select({ email: schema.usersTable.email })
      .from(schema.teamMembersTable)
      .innerJoin(
        schema.usersTable,
        eq(schema.teamMembersTable.userId, schema.usersTable.id),
      )
      .where(inArray(schema.teamMembersTable.teamId, [...teamIds]));

    const resolvedEmails = [
      ...new Set(
        rows
          .map((r) => r.email?.toLowerCase())
          .filter((e): e is string => typeof e === "string" && e.length > 0),
      ),
    ];

    return { resolvedEmails, unmappedGroups };
  }
}
