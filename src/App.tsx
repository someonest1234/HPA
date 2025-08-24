import './index.css'
import React, { useMemo, useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Clock,
  ChevronDown,
  ChevronRight,
  Package2,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Search,
  ExternalLink,
  Trash2,
} from 'lucide-react'

/**
 * HYBRID PARCEL TRACKER – MVP (FULL FILE)
 * ---------------------------------------------------------
 * Clean, single-file React + Tailwind UI with:
 * - Add tracking (tracking #, carrier, title, optional tracking URL)
 * - Auto-detect carrier from tracking number (TBA/AMZN = Amazon, digits = DPD, etc.)
 * - Search box (filters carrier/title/tracking)
 * - Paste email text → Extract tracking numbers → Add selected
 * - Card view with confidence, anomaly alerts, raw scan timeline
 * - Delete button per card
 * - Local persistence via localStorage (key: `hpa.parcels`)
 */

// ------------------- Types -------------------

type Phase =
  | 'Label Created'
  | 'In Transit'
  | 'At Customs'
  | 'Customs Cleared'
  | 'Held by Customs'
  | 'Out for Delivery'
  | 'Delivered'
  | 'Exception'
  | 'Unknown'

type ScanEvent = {
  ts: string
  location?: string
  code?: string
  message: string
  phaseHint?: Phase
}

type Parcel = {
  id: string
  carrier: string
  trackingNumber: string
  title?: string
  trackingUrl?: string
  scans: ScanEvent[]
  inferredPhase: Phase
  lastUpdated: string
  eta?: string
}

// ------------------- Dummy Fixtures -------------------

const FIXTURES: Parcel[] = [
  {
    id: 'p1',
    carrier: 'DPD',
    trackingNumber: '123456789012',
    title: 'Headphones',
    scans: [
      { ts: '2025-08-22T08:20:00Z', message: 'Shipment information received', phaseHint: 'Label Created' },
      { ts: '2025-08-22T12:00:00Z', message: 'Departed facility - Cologne, DE', location: 'Cologne, DE', phaseHint: 'In Transit' },
      { ts: '2025-08-23T07:00:00Z', message: 'Arrived at sortation hub - Dublin, IE', location: 'Dublin, IE', phaseHint: 'In Transit' },
    ],
    inferredPhase: 'In Transit',
    lastUpdated: '2025-08-23T07:00:00Z',
    eta: '2025-08-25T18:00:00Z',
  },
  {
    id: 'p2',
    carrier: 'Amazon Logistics',
    trackingNumber: 'TBA123456789',
    title: 'USB-C Cable',
    trackingUrl: 'https://www.amazon.ie/progress-tracker/package?trackingId=TBA123456789',
    scans: [
      { ts: '2025-08-23T09:00:00Z', message: 'Cleared customs', phaseHint: 'Customs Cleared' },
      { ts: '2025-08-23T16:00:00Z', message: 'Held for random inspection', phaseHint: 'Held by Customs' },
    ],
    inferredPhase: 'Held by Customs',
    lastUpdated: '2025-08-23T16:00:00Z',
  },
]

// ------------------- Helpers / Logic -------------------

function formatDT(iso?: string) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return d.toLocaleString()
  } catch {
    return iso ?? '—'
  }
}

function getLastScan(p: Parcel): ScanEvent | undefined {
  return [...p.scans].sort((a, b) => +new Date(b.ts) - +new Date(a.ts))[0]
}

// Heuristic carrier detection from tracking number
function detectCarrierFromTracking(tn: string): { carrier: string } {
  const s = tn.trim()
  if (!s) return { carrier: 'Unknown' }
  const U = s.toUpperCase()
  if (/^TBA[A-Z0-9]+$/.test(U) || /^AMZN[0-9A-Z]+$/.test(U)) return { carrier: 'Amazon Logistics' }
  if (/^1Z[0-9A-Z]+$/.test(U)) return { carrier: 'UPS' }
  if (/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(U) && U.endsWith('IE')) return { carrier: 'An Post' }
  if (/^\d{10,14}$/.test(U)) return { carrier: 'DPD' }
  return { carrier: 'Unknown' }
}

// Extract tracking numbers (and optional URLs) from free text (e.g., emails)
function extractCandidatesFromText(text: string): { trackingNumber: string; trackingUrl?: string }[] {
  const found: Record<string, { trackingNumber: string; trackingUrl?: string }> = {}
  const add = (tn: string, url?: string) => {
    const key = tn.trim().toUpperCase()
    if (!key) return
    if (!found[key]) found[key] = { trackingNumber: tn.trim(), trackingUrl: url }
  }
  // URLs first (amazon share links often have ?trackingId=…)
  for (const m of text.matchAll(/https?:\/\/[^\s)]+/gi)) {
    const url = m[0]
    try {
      const u = new URL(url)
      const qId = u.searchParams.get('trackingId') || u.searchParams.get('trackingNumber')
      if (qId) add(qId, url)
      const tba = u.pathname.match(/(TBA[A-Z0-9]+)/i)
      if (tba) add(tba[1], url)
    } catch {}
  }
  for (const m of text.matchAll(/\b(TBA[A-Z0-9]+|AMZN[0-9A-Z]+)\b/gi)) add(m[1]) // Amazon Logistics
  for (const m of text.matchAll(/\b(1Z[0-9A-Z]+)\b/gi)) add(m[1]) // UPS
  for (const m of text.matchAll(/\b([A-Z]{2}\d{9}[A-Z]{2})\b/g)) add(m[1]) // UPU (e.g., …IE)
  for (const m of text.matchAll(/\b(\d{10,14})\b/g)) add(m[1]) // DPD-ish heuristic
  return Object.values(found)
}

// Anomaly detection (reversal + stall)
function detectAnomalies(p: Parcel, stallHours = 48) {
  const scans = [...p.scans].sort((a, b) => +new Date(a.ts) - +new Date(b.ts))
  const last = scans[scans.length - 1]

  const order: Record<Phase, number> = {
    'Label Created': 0,
    'In Transit': 1,
    'At Customs': 2,
    'Held by Customs': 3,
    'Customs Cleared': 4,
    'Out for Delivery': 5,
    Delivered: 6,
    Exception: 7,
    Unknown: 1,
  }

  let reversed = false
  for (let i = 1; i < scans.length; i++) {
    const prev = scans[i - 1].phaseHint ?? 'Unknown'
    const curr = scans[i].phaseHint ?? 'Unknown'
    if (order[curr] < order[prev]) {
      reversed = true
      break
    }
  }

  const terminal = p.inferredPhase === 'Delivered' || p.inferredPhase === 'Exception'
  const hoursSinceLast = (Date.now() - +new Date(last?.ts ?? p.lastUpdated)) / 36e5
  const stalled = !terminal && hoursSinceLast > stallHours

  return { reversed, stalled, hoursSinceLast: Math.round(hoursSinceLast) }
}

// Confidence score (0–100): recency + agreement with last hint
function confidence(p: Parcel) {
  const last = getLastScan(p)
  const recencyHours = (Date.now() - +new Date(last?.ts ?? p.lastUpdated)) / 36e5
  const freshness = Math.max(0, 100 - Math.min(72, recencyHours) * (100 / 72))
  const agree = (last?.phaseHint ?? 'Unknown') === p.inferredPhase ? 100 : 50
  return Math.round(0.6 * freshness + 0.4 * agree)
}

// ------------------- UI Components -------------------

function PhaseBadge({ phase }: { phase: Phase }) {
  const color =
    phase === 'Delivered'
      ? 'bg-green-100 text-green-700 border-green-200'
      : phase === 'Out for Delivery'
      ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
      : phase === 'Held by Customs' || phase === 'Exception'
      ? 'bg-amber-100 text-amber-700 border-amber-200'
      : phase === 'Customs Cleared'
      ? 'bg-sky-100 text-sky-700 border-sky-200'
      : phase === 'At Customs'
      ? 'bg-blue-100 text-blue-700 border-blue-200'
      : 'bg-zinc-100 text-zinc-700 border-zinc-200'
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${color}`}>{phase}</span>
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
  )
}

function AnomalyBadge({ reversed, stalled, hours }: { reversed: boolean; stalled: boolean; hours: number }) {
  if (!reversed && !stalled) return null
  return (
    <div className="flex items-center gap-2 text-amber-700">
      <ShieldAlert className="h-4 w-4" />
      <span className="text-xs font-medium">{reversed ? 'Status reversal detected' : 'Potential stall'}</span>
      {stalled && <span className="text-xs text-amber-600">{hours}h since last scan</span>}
    </div>
  )
}

function ScanTimeline({ scans }: { scans: ScanEvent[] }) {
  const ordered = [...scans].sort((a, b) => +new Date(b.ts) - +new Date(a.ts))
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
  )
}

function ParcelCard({ parcel, onDelete }: { parcel: Parcel; onDelete: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const last = getLastScan(parcel)
  const anom = detectAnomalies(parcel, 48)
  const conf = confidence(parcel)

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
        <div className="flex flex-col items-end gap-2 min-w-[200px]">
          <ConfidenceMeter value={conf} />
          <AnomalyBadge reversed={anom.reversed} stalled={anom.stalled} hours={anom.hoursSinceLast} />

          {parcel.trackingUrl && (
            <a
              href={parcel.trackingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-800 hover:bg-zinc-50"
              title="Open official tracking page"
            >
              <ExternalLink className="h-3 w-3" /> Open tracking
            </a>
          )}

          <button
            type="button"
            onClick={() => {
              if (confirm('Delete this parcel?')) onDelete(parcel.id)
            }}
            className="inline-flex items-center gap-1 rounded-md border border-red-300 bg-white px-2 py-1 text-xs text-red-700 hover:bg-red-50"
            title="Delete parcel"
          >
            <Trash2 className="h-3 w-3" /> Delete
          </button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3 text-sm text-zinc-700">
        <div className="rounded-lg bg-zinc-50 border border-zinc-200 p-3">
          <div className="text-xs text-zinc-500">Last scan</div>
          <div className="font-medium">{last?.message ?? '—'}</div>
          <div className="text-xs text-zinc-600 mt-1">
            {formatDT(last?.ts)} {last?.location ? `• ${last.location}` : ''}
          </div>
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
            animate={{ height: 'auto', opacity: 1 }}
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
  )
}

// ------------------- App -------------------

export default function App() {
  const [q, setQ] = useState('')

  // Persisted parcels (localStorage) + seed with FIXTURES on first load
  const [parcels, setParcels] = useState<Parcel[]>(() => {
    try {
      const saved = localStorage.getItem('hpa.parcels')
      return saved ? (JSON.parse(saved) as Parcel[]) : FIXTURES
    } catch {
      return FIXTURES
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('hpa.parcels', JSON.stringify(parcels))
    } catch {}
  }, [parcels])

  // New parcel form state
  type NewParcel = { trackingNumber: string; carrier: string; title: string; trackingUrl: string }
  const [newP, setNewP] = useState<NewParcel>({ trackingNumber: '', carrier: '', title: '', trackingUrl: '' })
  const [carrierTouched, setCarrierTouched] = useState(false)

  function addParcel(e: React.FormEvent) {
    e.preventDefault()
    const tn = newP.trackingNumber.trim()
    if (!tn) return
    const np: Parcel = {
      id: `p${Date.now()}`,
      carrier: newP.carrier.trim() || 'Unknown',
      trackingNumber: tn,
      title: newP.title.trim() || undefined,
      trackingUrl: newP.trackingUrl.trim() || undefined,
      scans: [],
      inferredPhase: 'Unknown',
      lastUpdated: new Date().toISOString(),
      eta: undefined,
    }
    setParcels([np, ...parcels])
    setNewP({ trackingNumber: '', carrier: '', title: '', trackingUrl: '' })
    setCarrierTouched(false)
    setQ('')
  }

  function handleDelete(id: string) {
    setParcels((prev) => prev.filter((p) => p.id !== id))
  }

  const filtered = useMemo(() => {
    const needle = q.toLowerCase()
    return parcels.filter((p) => `${p.title ?? ''} ${p.carrier} ${p.trackingNumber}`.toLowerCase().includes(needle))
  }, [parcels, q])

  // Extractor state
  const [pasteText, setPasteText] = useState('')
  const [extracted, setExtracted] = useState<{ trackingNumber: string; trackingUrl?: string }[]>([])
  const [selected, setSelected] = useState<Record<string, boolean>>({})

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
        <form onSubmit={addParcel} className="grid gap-3 rounded-2xl border border-zinc-300 bg-white p-3 shadow-sm md:grid-cols-5">
          <input
            value={newP.trackingNumber}
            onChange={(e) => {
              const tracking = e.target.value
              setNewP((prev) => {
                const guess = detectCarrierFromTracking(tracking).carrier
                const nextCarrier = prev.carrier?.trim() ? prev.carrier : guess !== 'Unknown' ? guess : ''
                return { ...prev, trackingNumber: tracking, carrier: nextCarrier }
              })
            }}
            placeholder="Tracking number*"
            className="rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none"
            required
          />
          <input
            value={newP.carrier}
            onChange={(e) => {
              setCarrierTouched(true)
              setNewP({ ...newP, carrier: e.target.value })
            }}
            placeholder="Carrier (optional)"
            className="rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none"
          />
          <input
            value={newP.title}
            onChange={(e) => setNewP({ ...newP, title: e.target.value })}
            placeholder="Label (optional)"
            className="rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none"
          />
          <input
            value={newP.trackingUrl}
            onChange={(e) => setNewP({ ...newP, trackingUrl: e.target.value })}
            placeholder="Amazon share link (optional)"
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

        {/* Paste email text → extract tracking numbers */}
        <div className="rounded-2xl border border-zinc-300 bg-white p-3 shadow-sm space-y-3">
          <div className="text-sm font-medium">Paste email text to extract tracking numbers</div>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="Paste Amazon/DPD email or tracking page text here..."
            className="w-full h-28 resize-vertical rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const cands = extractCandidatesFromText(pasteText)
                const existing = new Set(parcels.map((p) => p.trackingNumber.toUpperCase()))
                const fresh = cands.filter((c) => !existing.has(c.trackingNumber.toUpperCase()))
                setExtracted(fresh)
                const sel: Record<string, boolean> = {}
                fresh.forEach((c) => (sel[c.trackingNumber.toUpperCase()] = true))
                setSelected(sel)
              }}
              className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800"
            >
              Extract
            </button>
            {extracted.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  const toAdd = extracted.filter((c) => selected[c.trackingNumber.toUpperCase()])
                  if (toAdd.length === 0) return
                  const added: Parcel[] = toAdd.map((c) => ({
                    id: `p${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                    carrier: detectCarrierFromTracking(c.trackingNumber).carrier,
                    trackingNumber: c.trackingNumber,
                    title: undefined,
                    trackingUrl: c.trackingUrl,
                    scans: [],
                    inferredPhase: 'Unknown',
                    lastUpdated: new Date().toISOString(),
                    eta: undefined,
                  }))
                  setParcels((prev) => [...added, ...prev])
                  setExtracted([])
                  setSelected({})
                  setPasteText('')
                }}
                className="inline-flex items-center gap-2 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50"
              >
                Add selected ({Object.values(selected).filter(Boolean).length})
              </button>
            )}
          </div>

          {extracted.length > 0 && (
            <div className="space-y-2">
              {extracted.map((c) => (
                <label key={c.trackingNumber} className="flex items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={!!selected[c.trackingNumber.toUpperCase()]}
                    onChange={(e) =>
                      setSelected((prev) => ({ ...prev, [c.trackingNumber.toUpperCase()]: e.target.checked }))
                    }
                  />
                  <span className="font-mono">{c.trackingNumber}</span>
                  <span className="text-zinc-500">• {detectCarrierFromTracking(c.trackingNumber).carrier}</span>
                  {c.trackingUrl && (
                    <a href={c.trackingUrl} target="_blank" rel="noopener noreferrer" className="text-zinc-700 underline">
                      link
                    </a>
                  )}
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="grid gap-4">
          {filtered.map((p) => (
            <ParcelCard key={p.id} parcel={p} onDelete={handleDelete} />
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
  )
}
