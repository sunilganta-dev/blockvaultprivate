// src/threat.ts
export type ThreatSignals = {
    motionScore: number;
    threshold: number;
    burstMs: number;
    afterHours: boolean;
    roiBreach: boolean;
    repeatCount60s: number;
    tamperSuspected: boolean;
  };
  
  export type ThreatResult = {
    threatScore: number; // 0..100
    threatLevel: "LOW" | "MEDIUM" | "HIGH";
    signals: ThreatSignals;
    reasons: string[]; // human-readable explanation for demo
  };
  
  function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(max, n));
  }
  
  function level(score: number): "LOW" | "MEDIUM" | "HIGH" {
    if (score >= 70) return "HIGH";
    if (score >= 35) return "MEDIUM";
    return "LOW";
  }
  
  export function isAfterHoursNow(opts?: { startHour?: number; endHour?: number }): boolean {
    const start = opts?.startHour ?? 7;  // allowed hours start
    const end = opts?.endHour ?? 19;     // allowed hours end
    const h = new Date().getHours();
    return !(h >= start && h < end);
  }
  
  /**
   * Lightweight, explainable threat scoring (MVP)
   * Inputs are mostly from browser meta (motionScore, threshold, burstMs, roiBreach),
   * plus server-derived context (afterHours, repeatCount60s).
   */
  export function computeThreat(input: {
    motionScore: number;
    threshold: number;
    burstMs: number;
    roiBreach: boolean;
    repeatCount60s: number;
    afterHours: boolean;
    tamperSuspected: boolean;
  }): ThreatResult {
    const reasons: string[] = [];
  
    // 1) Motion component (scaled)
    // motionScore tends to be a small-ish float. This maps it to meaningful risk.
    let score = 0;
  
    const motionComponent = clamp((input.motionScore / Math.max(1, input.threshold)) * 35, 0, 35);
    score += motionComponent;
    if (motionComponent > 10) reasons.push(`Motion above threshold (${input.motionScore.toFixed(2)} > ${input.threshold})`);
  
    // 2) Persistence (continuous motion)
    // Longer bursts mean more credible intrusion vs flicker.
    let burstComponent = 0;
    if (input.burstMs >= 8000) burstComponent = 28;
    else if (input.burstMs >= 4000) burstComponent = 18;
    else if (input.burstMs >= 2000) burstComponent = 10;
    score += burstComponent;
    if (burstComponent > 0) reasons.push(`Persistent motion (${Math.round(input.burstMs)}ms)`);
  
    // 3) ROI breach (restricted zone)
    let roiComponent = input.roiBreach ? 25 : 0;
    score += roiComponent;
    if (roiComponent) reasons.push("Restricted zone breached");
  
    // 4) After-hours
    let afterHoursComponent = input.afterHours ? 18 : 0;
    score += afterHoursComponent;
    if (afterHoursComponent) reasons.push("After-hours activity");
  
    // 5) Repeat events in 60s (escalation)
    const repeatComponent = clamp(input.repeatCount60s * 8, 0, 24);
    score += repeatComponent;
    if (repeatComponent) reasons.push(`Repeat activity (${input.repeatCount60s} in 60s)`);
  
    // 6) Tamper suspected (blackout/cover/abnormal)
    const tamperComponent = input.tamperSuspected ? 35 : 0;
    score += tamperComponent;
    if (tamperComponent) reasons.push("Camera tamper suspected");
  
    const threatScore = clamp(Math.round(score), 0, 100);
  
    return {
      threatScore,
      threatLevel: level(threatScore),
      signals: {
        motionScore: input.motionScore,
        threshold: input.threshold,
        burstMs: input.burstMs,
        afterHours: input.afterHours,
        roiBreach: input.roiBreach,
        repeatCount60s: input.repeatCount60s,
        tamperSuspected: input.tamperSuspected
      },
      reasons
    };
  }
  