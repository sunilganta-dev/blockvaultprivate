"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IncidentContract = void 0;
const fabric_contract_api_1 = require("fabric-contract-api");
function keyFor(id) {
    return `INCIDENT_${id}`;
}
class IncidentContract extends fabric_contract_api_1.Contract {
    async Ping(ctx) {
        return "ok";
    }
    async CreateIncident(ctx, incidentJson) {
        const incident = JSON.parse(incidentJson);
        if (!incident?.incidentId)
            throw new Error("incidentId is required");
        const k = keyFor(incident.incidentId);
        const exists = await this.IncidentExists(ctx, incident.incidentId);
        if (exists)
            throw new Error(`Incident already exists: ${incident.incidentId}`);
        // Basic normalization
        if (!incident.ts)
            incident.ts = new Date().toISOString();
        if (typeof incident.severity !== "number")
            incident.severity = 0;
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
    async GetIncident(ctx, incidentId) {
        const data = await ctx.stub.getState(keyFor(incidentId));
        if (!data || data.length === 0)
            throw new Error(`Incident not found: ${incidentId}`);
        return data.toString("utf8");
    }
    async IncidentExists(ctx, incidentId) {
        const data = await ctx.stub.getState(keyFor(incidentId));
        return !!data && data.length > 0;
    }
    async GetAllIncidents(ctx) {
        const iter = await ctx.stub.getStateByRange("", "");
        const out = [];
        for await (const r of iter) {
            const k = r.key;
            if (!k.startsWith("INCIDENT_"))
                continue;
            out.push(JSON.parse(r.value.toString("utf8")));
        }
        // Sort by timestamp (best-effort)
        out.sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
        return JSON.stringify(out);
    }
}
exports.IncidentContract = IncidentContract;
