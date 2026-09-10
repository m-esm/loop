import { eq } from 'drizzle-orm';
import type { AgentConfig } from './agents';
import type { Database } from './database';
import { principals } from './schema';

export function syncAgentPrincipals(database: Database, agents: AgentConfig[]) {
  const ts = new Date().toISOString();
  for (const agent of agents) {
    const existing = database.db.select().from(principals).where(eq(principals.id, agent.id)).get();
    if (existing) {
      if (existing.kind !== 'agent') continue;
      if (existing.displayName !== agent.name) {
        database.db.update(principals).set({ displayName: agent.name }).where(eq(principals.id, agent.id)).run();
      }
      continue;
    }
    database.db.insert(principals).values({
      id: agent.id, kind: 'agent', displayName: agent.name, createdAt: ts,
    }).run();
  }
}
