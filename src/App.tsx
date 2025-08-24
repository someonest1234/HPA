import React, { useMemo, useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, Clock, ChevronDown, ChevronRight, Package2, RefreshCw, ShieldAlert, Sparkles, Search } from "lucide-react";

/**
 * HYBRID PARCEL TRACKER – MVP SEED
 * ---------------------------------------------------------
 * Goals
 *  - Show BOTH process phase and raw scan timeline (data = UX)
 *  - Detect reversals/stalls and surface as alerts (transparency)
 *  - Provide a simple card UI with an expandable raw log
 *  - Include a confidence score derived from (scan fidelity vs. inference)
 *
 * How to use in CursorAI:
 *  - Drop this file into a React + Tailwind project
 *  - Ensure tailwind is configured; this uses utility classes only
 *  - No external data needed; dummy data lives below
 */

/**
 * Domain Model (dummy schema)
 * ---------------------------------------------------------
 * Parcel {
 *   id: string
 *   carrier: "DPD" | "UPS" | "USPS" | "AnPost" | string
 *   trackingNumber: string
 *   title?: string                    // optional user label
 *   scans: ScanEvent[]                // verbatim courier events (truth layer)
 *   inferredPhase: Phase              // current inferred process state
 *   lastUpdated: string               // ISO
 *   eta?: string                      // optional ETA from carrier or model
 * }
 *
 * ScanEvent {
 *   ts: string                        // ISO timestamp
 *   location?: string
 *   code?: string                     // courier code if available
 *   message: string                   // exact courier text
 *   phaseHint?: Phase                 // optional hint mapping
 * }
 *
 * Phase =
 *  "Label Created" | "In Transit" | "At Customs" | "Customs Cleared" |
 *  "Held by Customs" | "Out for Delivery" | "Delivered" | "Exception" | "Unknown"
 */

// ------------------- Dummy Fixtures -------------------

const FIXTURES: Parcel[] = [
  {
    id: "p1",
    carrier: "DPD",
    trackingNumber: "DPD-IE-123456789",
    title: "ThinkPad T490 (refurb)",
    scans: [
      { ts: "2025-08-20T08:12:00Z", location: "DE Hamburg Hub", code: "DEP_IN", message: "Parcel collected from sender", phaseHint: "In Transit" },
      { ts: "2025-08-21T04:02:00Z", location: "IE Athlone", code: "CUST_ARR", message: "Arrived at customs facility", phaseHint: "At Customs" },
      { ts: "2025-08-21T12:33:00Z", location: "IE Athlone", code: "CUST_CLR", message: "Released by customs (green lane)", phaseHint: "Customs Cleared" },
      // Reversal (pulled back)
      { ts: "2025-08-22T10:41:00Z", location: "IE Athlone", code: "CUST_HOLD", message: "Selected for inspection. Clearance pending.", phaseHint: "Held by Customs" },
    ],
    inferredPhase: "Held by Customs",
    lastUpdated: "2025-08-22T10:41:00Z",
    eta: undefined,
  },
  {
    id: "p2",
    carrier: "Amazon Logistics",
    trackingNumber: "AMZ-IE-987654321",
    title: "USB-C 240W Cable",
    scans: [
      { ts: "2025-08-23T07:00:00Z", location: "IE Dublin", code: "FC_DISP", message: "Package departed Amazon facility", phaseHint: "In Transit" },
      { ts: "2025-08-23T12:12:00Z", location: "IE Dublin", code: "DST_SORT", message: "Arrived at carrier facility", phaseHint: "In Transit" },
      { ts: "2025-08-24T07:31:00Z", location: "IE Dublin", code: "OUT_DRV", message: "Out for delivery", phaseHint: "Out for Delivery" },
    ],
    inferredPhase: "Out for Delivery",
    lastUpdated: "2025-08-24T07:31:00Z",
    eta: "2025-08-24T17:00:00Z",
  },
  {
    id: "p3",
    carrier: "An Post",
    trackingNumber: "ANP-IE-555111222",
    title: "Notebook Stand",
    scans: [
      { ts: "2025-08-18T09:22:00Z", location: "IE Portlaoise", code: "SORT_ARR", message: "Arrived at sorting center", phaseHint: "In Transit" },
      { ts: "2025-08-19T14:02:00Z", location: "IE Portlaoise", code: "SORT_DEP", message: "Departed sorting center", phaseHint: "In Transit" },
      { ts: "2025-08-19T18:45:00Z", location: "IE Dublin", code: "DLVD", message: "Delivered", phaseHint: "Delivered" },
    ],
    inferredPhase: "Delivered",
    lastUpdated: "2025-08-19T18:45:00Z",
    eta: "2025-08-19T18:00:00Z",
  },
];

// ------------------- Types -------------------

type Phase =
  | "Label Created"
  | "In Transit"
  | "At Customs"
  | "Customs Cleared"
  | "Held by Customs"
  | "Out for Delivery"
  | "Delivered"
  | "Exception"
  | "Unknown";

type ScanEvent = {
  ts: string;
  location?: string;
  code?: string;
  message: string;
  phaseHint?: Phase;
};

type Parcel = {
  id: string;
  carrier: string;
  trackingNumber: string;
  title?: string;
  scans: ScanEvent[];
  inferredPhase: Phase;
  lastUpdated: string;
  eta?: string;
};

// ------------------- Helpers / Logic -------------------

function formatDT(iso?: string) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso ?? "—";
  }
}

function getLastScan(p: Parcel): ScanEvent | undefined {
  return [...p.scans].sort((a, b) => +new Date(b.ts) - +new Date(a.ts))[0];
}

/**
 * Anomaly detection
 * - Reversal: later scan indicates a more regressive phase than earlier scan (e.g., Cleared -> Hold)
 * - Stall: no scans in > X hours (default 48h) and phase not terminal
 */
function detectAnomalies(p: Parcel, stallHours = 48) {
  const scans = [...p.scans].sort((a, b) => +new Date(a.ts) - +new Date(b.ts));
  const last = scans[scans.length - 1];

  // Map phase order for directional comparison
  const order: Record<Phase, number> = {
    "Label Created": 0,
    "In Transit": 1,
    "At Customs": 2,
    "Held by Customs": 3,
    "Customs Cleared": 4,
    "Out for Delivery": 5,
    Delivered: 6,
    Exception: 7,
    Unknown: 1,
  };

  let reversed = false;
  for (let i = 1; i < scans.length; i++) {
    const prev = scans[i - 1].phaseHint ?? "Unknown";
    const curr = scans[i].phaseHint ?? "Unknown";
    if (order[curr] < order[prev]) {
      reversed = true;
      break;
    }
  }

  const terminal = p.inferredPhase === "Delivered" || p.inferredPhase === "Exception";
  const hoursSinceLast = (Date.now() - +new Date(last?.ts ?? p.lastUpdated)) / 36e5;
  const stalled = !terminal && hoursSinceLast > stallHours;

  return { reversed, stalled, hoursSinceLast: Math.round(hoursSinceLast) };
}

/** Confidence scoring
 * 0–100 from two signals:
 *  - last scan recency (freshness)
 *  - agreement between inferredPhase and last phaseHint
 */
function confidence(p: Parcel) {
  const last = getLastScan(p);
  const recencyHours = (Date.now() - +new Date(last?.ts ?? p.lastUpdated)) / 36e5;
  const freshness = Math.max(0, 100 - Math.min(72, recencyHours) * (100 / 72)); // linear drop over 72h
  const agree = (last?.phaseHint ?? "Unknown") === p.inferredPhase ? 100 : 50;
  return Math.round(0.6 * freshness + 0.4 * agree);
}

// ------------------- UI Components -------------------

function PhaseBadge({ phase }: { phase: Phase }) {
  const color =
    phase === "Delivered"
      ? "bg-green-100 text-green-700 border-green-200"
      : phase === "Out for Delivery"
      ? "bg-emerald-100 text-emerald-700 border-emerald-200"
      : phase === "Held by Customs" || phase === "Exception"
      ? "bg-amber-100 text-amber-700 border-amber-200"
      : phase === "Customs Cleared"
      ? "bg-sky-100 text-sky-700 border-sky-200"
      : phase === "At Customs"
      ? "bg-blue-100 text-blue-700 border-blue-200"
      : "bg-zinc-100 text-zinc-700 border-zinc-200";
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${color}`}>{phase}</span>;
}

function ConfidenceMeter({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-2" title={`Confidence: ${value}%`}>
      <Sparkles className="h-4 w-4" />
      <div className="h-2 w-24 rounded-full bg-zinc-200 overflow-hidden">
        <div className="h-full bg-zinc-800" style={{ width: `${value}%` }} />
      </div>
      <span className="text-xs tabular-nums text-zinc-600">{value}%</span>
    </div>
  );
}

function AnomalyBadge({ reversed, stalled, hours }: { reversed: boolean; stalled: boolean; hours: number }) {
  if (!reversed && !stalled) return null;
  return (
    <div className="flex items-center gap-2 text-amber-700">
      <ShieldAlert className="h-4 w-4" />
      <span className="text-xs font-medium">{reversed ? "Status reversal detected" : "Potential stall"}</span>
      {stalled && <span className="text-xs text-amber-600">{hours}h since last scan</span>}
    </div>
  );
}

function ScanTimeline({ scans }: { scans: ScanEvent[] }) {
  const ordered = [...scans].sort((a, b) => +new Date(b.ts) - +new Date(a.ts));
  return (
    <ul className="space-y-3">
      {ordered.map((s, i) => (
        <li key={i} className="relative pl-6">
          <span className="absolute left-0 top-1.5 h-3 w-3 rounded-full bg-zinc-400" />
          <div className="text-sm font-medium">{s.message}</div>
          <div className="text-xs text-zinc-600 flex items-center gap-2">
            <Clock className="h-3 w-3" /> {formatDT(s.ts)}
            {s.location && <span>• {s.location}</span>}
            {s.code && <span className="font-mono bg-zinc-100 border border-zinc-200 rounded px-1">{s.code}</span>}
            {s.phaseHint && (
              <span className="ml-2">
                <PhaseBadge phase={s.phaseHint} />
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function ParcelCard({ parcel }: { parcel: Parcel }) {
  const [open, setOpen] = useState(false);
  const last = getLastScan(parcel);
  const anom = detectAnomalies(parcel, 48);
  const conf = confidence(parcel);

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white shadow-sm p-4 md:p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-xl bg-zinc-900 text-white flex items-center justify-center">
            <Package2 className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold">{parcel.title ?? parcel.trackingNumber}</h3>
              <PhaseBadge phase={parcel.inferredPhase} />
            </div>
            <div className="text-sm text-zinc-600">
              {parcel.carrier} • <span className="font-mono">{parcel.trackingNumber}</span>
            </div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2 min-w-[180px]">
          <ConfidenceMeter value={conf} />
          <AnomalyBadge reversed={anom.reversed} stalled={anom.stalled} hours={anom.hoursSinceLast} />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3 text-sm text-zinc-700">
        <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
          <div className="text-xs text-zinc-500">Last scan</div>
          <div className="font-medium">{last?.message ?? "—"}</div>
          <div className="text-xs text-zinc-600 mt-1">{formatDT(last?.ts)} {last?.location ? `• ${last.location}` : ""}</div>
        </div>
        <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
          <div className="text-xs text-zinc-500">Process state</div>
          <div className="font-medium">{parcel.inferredPhase}</div>
          <div className="text-xs text-zinc-600 mt-1">Updated {formatDT(parcel.lastUpdated)}</div>
        </div>
        <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
          <div className="text-xs text-zinc-500">ETA</div>
          <div className="font-medium">{formatDT(parcel.eta)}</div>
        </div>
      </div>

      <button
        onClick={() => setOpen(!open)}
        className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-zinc-900 hover:text-zinc-700"
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />} Raw scan timeline
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-3">
              <ScanTimeline scans={parcel.scans} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function App() {
  const [q, setQ] = useState("");

  // Persisted parcels (localStorage) + seed with FIXTURES on first load
  const [parcels, setParcels] = useState<Parcel[]>(() => {
    try {
      const saved = localStorage.getItem("hpa.parcels");
      return saved ? (JSON.parse(saved) as Parcel[]) : FIXTURES;
    } catch {
      return FIXTURES;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("hpa.parcels", JSON.stringify(parcels));
    } catch {}
  }, [parcels]);

  // New parcel form state
  type NewParcel = { trackingNumber: string; carrier: string; title: string };
  const [newP, setNewP] = useState<NewParcel>({ trackingNumber: "", carrier: "", title: "" });

  function addParcel(e: React.FormEvent) {
    e.preventDefault();
    const tn = newP.trackingNumber.trim();
    if (!tn) return;
    const np: Parcel = {
      id: `p${Date.now()}`,
      carrier: newP.carrier.trim() || "Unknown",
      trackingNumber: tn,
      title: newP.title.trim() || undefined,
      scans: [],
      inferredPhase: "Unknown",
      lastUpdated: new Date().toISOString(),
      eta: undefined,
    };
    setParcels([np, ...parcels]);
    setNewP({ trackingNumber: "", carrier: "", title: "" });
    setQ("");
  }

  const filtered = useMemo(() => {
    const needle = q.toLowerCase();
    return parcels.filter((p) => `${p.title ?? ""} ${p.carrier} ${p.trackingNumber}`.toLowerCase().includes(needle));
  }, [parcels, q]);

  return (
    <div className="min-h-screen bg-zinc-100 p-4 md:p-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Hybrid Parcel Tracker</h1>
            <p className="text-zinc-600 mt-1">Raw scan truth + process context. No lies, no vibes-only.</p>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-2 rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm hover:bg-zinc-50"
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
        </header>

        {/* Add Tracking Number form */}
        <form onSubmit={addParcel} className="grid gap-3 rounded-2xl border border-zinc-300 bg-white p-3 shadow-sm md:grid-cols-4">
          <input
            value={newP.trackingNumber}
            onChange={(e) => setNewP({ ...newP, trackingNumber: e.target.value })}
            placeholder="Tracking number*"
            className="rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none"
            required
          />
          <input
            value={newP.carrier}
            onChange={(e) => setNewP({ ...newP, carrier: e.target.value })}
            placeholder="Carrier (optional)"
            className="rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none"
          />
          <input
            value={newP.title}
            onChange={(e) => setNewP({ ...newP, title: e.target.value })}
            placeholder="Label (optional)"
            className="rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none"
          />
          <button
            type="submit"
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800"
          >
            <Package2 className="h-4 w-4" /> Add
          </button>
        </form>

        {/* Search box */}
        <div className="flex items-center gap-2 rounded-2xl border border-zinc-300 bg-white px-3 py-2 shadow-sm">
          <Search className="h-4 w-4 text-zinc-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search carrier, title, or tracking number"
            className="w-full bg-transparent py-2 outline-none text-sm"
          />
        </div>

        <div className="grid gap-4">
          {filtered.map((p) => (
            <ParcelCard key={p.id} parcel={p} />
          ))}
          {filtered.length === 0 && (
            <div className="text-center text-zinc-600 py-10">No parcels match your search.</div>
          )}
        </div>

        <footer className="pt-4 text-xs text-zinc-500">
          <div className="font-medium mb-1">Design Tenets</div>
          <ul className="list-disc ml-4 space-y-1">
            <li>Data = UX: Raw scans are always available, verbatim.</li>
            <li>Process = Context: Phases interpret, never overwrite.</li>
            <li>Honesty over certainty: Confidence meter shows ambiguity.</li>
            <li>Alerts when it matters: Reversal & stall detection surface risk.</li>
          </ul>
        </footer>
      </div>
    </div>
  );
}
