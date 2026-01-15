import { Context, Contract } from "fabric-contract-api";

type Incident = {
  incidentId: string;
  ts: string;               // ISO timestamp
  cameraId: string;
  type: string;             // MOTION, AFTER_HOURS, ROI_BREACH, etc.
  severity: number;         // 0-100
  evidenceUri: string;      // off-chain URL
  evidenceHash: string;     // sha256
  metadataHash: string;     // sha256 of canonical metadata JSON
  meta?: Record<string, unknown>;
};

function keyFor(id: string) {
  return `INCIDENT_${id}`;
}

export class IncidentContract extends Contract {
  async Ping(ctx: Context): Promise<string> {
    return "ok";
  }

  async CreateIncident(ctx: Context, incidentJson: string): Promise<string> {
    const incident = JSON.parse(incidentJson) as Incident;

    if (!incident?.incidentId) throw new Error("incidentId is required");
    const k = keyFor(incident.incidentId);

    const exists = await this.IncidentExists(ctx, incident.incidentId);
    if (exists) throw new Error(`Incident already exists: ${incident.incidentId}`);

    // Basic normalization
    if (!incident.ts) incident.ts = new Date().toISOString();
    if (typeof incident.severity !== "number") incident.severity = 0;

    await ctx.stub.putState(k, Buffer.from(JSON.stringify(incident)));

    // Emit event for realtime UI later (optional)
    ctx.stub.setEvent("IncidentCreated", Buffer.from(JSON.stringify({
      incidentId: incident.incidentId,
      ts: incident.ts,
      type: incident.type,
      severity: incident.severity
    })));

    return JSON.stringify({ ok: true, incidentId: incident.incidentId });
  }

  async GetIncident(ctx: Context, incidentId: string): Promise<string> {
    const data = await ctx.stub.getState(keyFor(incidentId));
    if (!data || data.length === 0) throw new Error(`Incident not found: ${incidentId}`);
    return data.toString("utf8");
  }

  async IncidentExists(ctx: Context, incidentId: string): Promise<boolean> {
    const data = await ctx.stub.getState(keyFor(incidentId));
    return !!data && data.length > 0;
  }

  async GetAllIncidents(ctx: Context): Promise<string> {
    const iter = await ctx.stub.getStateByRange("", "");
    const out: Incident[] = [];

    for await (const r of iter) {
      const k = r.key as string;
      if (!k.startsWith("INCIDENT_")) continue;
      out.push(JSON.parse(r.value.toString("utf8")));
    }

    // Sort by timestamp (best-effort)
    out.sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
    return JSON.stringify(out);
  }
}
