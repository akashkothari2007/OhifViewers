import { useState, useRef, useCallback } from 'react'
import './App.css'

// ── Types ────────────────────────────────────────────────────────────────────

interface PatientData {
  ModalitiesInStudy: string[]
  numberOfDisplaySetsWithImages: number
  hasPrior: boolean
}

interface Patient {
  id: string
  name: string
  description: string
  data: PatientData
}

interface Rule {
  label: string
  weight: number
  required: boolean
  check: (d: PatientData) => boolean
}

interface Protocol {
  id: string
  label: string
  description: string
  rules: Rule[]
}

interface FlowStep {
  label: string
  sub: string
  type: 'trigger' | 'orchestration' | 'scoring' | 'output'
}

interface RuleResult {
  pass: boolean
  disqualifies: boolean
  weightAdded: number
}

interface ProtocolResult {
  score: number
  disqualified: boolean
  ruleResults: RuleResult[]
}

interface RevealedRule {
  label: string
  pass: boolean
  disqualifies: boolean
  weight: number
  required: boolean
  evalState: 'pending' | 'resolved'  // pending = yellow, resolved = pass/fail
}

interface ProtocolDisplayState {
  visible: boolean
  score: number
  disqualified: boolean
  shaking: boolean
  winner: boolean
  revealedRules: RevealedRule[]
}

interface AppState {
  phase: 'idle' | 'running' | 'complete'
  activeFlowStep: number
  loopFlowStep: number   // 3 or 4 (back-and-forth during scoring), -1 otherwise
  protocols: ProtocolDisplayState[]
  winnerName: string
  winnerScore: number
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PATIENTS: Patient[] = [
  {
    id: 'A',
    name: 'Study A',
    description: 'Mammography screening · Active: MG · 1 prior MG study',
    data: { ModalitiesInStudy: ['MG'], numberOfDisplaySetsWithImages: 4, hasPrior: true },
  },
  {
    id: 'B',
    name: 'Study B',
    description: 'Chest CT · Active: CT · 1 prior CT study',
    data: { ModalitiesInStudy: ['CT'], numberOfDisplaySetsWithImages: 5, hasPrior: true },
  },
  {
    id: 'C',
    name: 'Study C',
    description: 'Brain MRI · Active: MRI · no priors',
    data: { ModalitiesInStudy: ['MRI'], numberOfDisplaySetsWithImages: 2, hasPrior: false },
  },
]

const PROTOCOLS: Protocol[] = [
  {
    id: 'hpCompare',
    label: '@ohif/hpCompare',
    description: 'Compare Two Studies',
    rules: [
      {
        label: 'Prior study is available',
        weight: 1000,
        required: true,
        check: (d) => d.hasPrior,
      },
    ],
  },
  {
    id: 'hpMammo',
    label: '@ohif/hpMammo',
    description: 'Mammography Breast Screening',
    rules: [
      {
        label: "ModalitiesInStudy contains 'MG'",
        weight: 150,
        required: true,
        check: (d) => d.ModalitiesInStudy.includes('MG'),
      },
      {
        label: 'numberOfDisplaySetsWithImages > 2',
        weight: 1,
        required: true,
        check: (d) => d.numberOfDisplaySetsWithImages > 2,
      },
    ],
  },
  {
    id: 'hpScale',
    label: '@ohif/hpScale',
    description: 'Scale Images (generic fallback)',
    rules: [
      {
        label: 'numberOfDisplaySetsWithImages > 0',
        weight: 25,
        required: false,
        check: (d) => d.numberOfDisplaySetsWithImages > 0,
      },
    ],
  },
  {
    id: 'hpMNGrid',
    label: '@ohif/mnGrid',
    description: 'Multi-Series Grid 2×2',
    rules: [
      {
        label: 'numberOfDisplaySetsWithImages > 0',
        weight: 25,
        required: false,
        check: (d) => d.numberOfDisplaySetsWithImages > 0,
      },
    ],
  },
]

const FLOW_STEPS: FlowStep[] = [
  { label: 'User Action', sub: 'Trigger', type: 'trigger' },
  { label: 'HangingProtocolService.run()', sub: 'HangingProtocolService.ts:422', type: 'orchestration' },
  { label: 'ProtocolEngine.run()', sub: 'ProtocolEngine.js:18 → getBestProtocolMatch()', type: 'orchestration' },
  { label: 'findMatchByStudy()', sub: 'ProtocolEngine.js:107 — iterates every registered protocol', type: 'orchestration' },
  { label: 'HPMatcher.match()', sub: 'HPMatcher.js:12 — score += parseInt(rule.weight || 1)', type: 'scoring' },
  { label: 'Winner Selected', sub: 'sortByScore.js · _getHighestScoringProtocol() · _setProtocol()', type: 'output' },
]

// Timing constants (ms) — total demo ≈ 19–22s for Patient A (×1.35 slower)
const T = {
  FLOW_STEP:   1080,   // delay between each flow block lighting up
  INIT_PAUSE:  1350,   // pause at HPMatcher before first protocol
  LOOP3:        610,   // step 3 "loop glow" duration before card slides in
  CARD_SETTLE:  740,   // after card slides in before first rule appears
  PENDING:      610,   // how long a rule stays yellow/pending
  POST_RESOLVE: 740,   // after resolving a rule before the next rule appears
  INTER_PROTO: 1000,   // extra gap between protocols (on top of POST_RESOLVE)
  PRE_WINNER:  1350,   // pause after all protocols done before winner badge
  WINNER_TO_5: 1500,   // from winner badge to flow step 5 + result card
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function computeResults(data: PatientData): ProtocolResult[] {
  return PROTOCOLS.map((protocol) => {
    let score = 0
    let disqualified = false
    const ruleResults: RuleResult[] = protocol.rules.map((rule) => {
      if (disqualified) return { pass: false, disqualifies: false, weightAdded: 0 }
      const pass = rule.check(data)
      if (pass) {
        score += rule.weight
        return { pass: true, disqualifies: false, weightAdded: rule.weight }
      } else if (rule.required) {
        score = 0
        disqualified = true
        return { pass: false, disqualifies: true, weightAdded: 0 }
      }
      return { pass: false, disqualifies: false, weightAdded: 0 }
    })
    return { score, disqualified, ruleResults }
  })
}

function makeInitialProtocols(): ProtocolDisplayState[] {
  return PROTOCOLS.map(() => ({
    visible: false,
    score: 0,
    disqualified: false,
    shaking: false,
    winner: false,
    revealedRules: [],
  }))
}

function makeResetState(): AppState {
  return {
    phase: 'idle',
    activeFlowStep: -1,
    loopFlowStep: -1,
    protocols: makeInitialProtocols(),
    winnerName: '',
    winnerScore: 0,
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function App() {
  const [selectedId, setSelectedId] = useState<string>('A')
  const [state, setState] = useState<AppState>(makeResetState)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  const clearTimers = () => {
    timers.current.forEach(clearTimeout)
    timers.current = []
  }

  const at = (fn: () => void, delay: number) => {
    timers.current.push(setTimeout(fn, delay))
  }

  const runAnimation = useCallback(() => {
    clearTimers()
    const patient = PATIENTS.find((p) => p.id === selectedId)
    if (!patient) return
    const results = computeResults(patient.data)

    setState({ phase: 'running', activeFlowStep: -1, loopFlowStep: -1, protocols: makeInitialProtocols(), winnerName: '', winnerScore: 0 })

    let t = 0

    // ── Flow steps 0–3: 800ms apart, no looping yet
    for (let i = 0; i <= 3; i++) {
      const step = i
      at(() => setState((s) => ({ ...s, activeFlowStep: step, loopFlowStep: -1 })), t)
      t += T.FLOW_STEP
    }

    // ── Step 4: HPMatcher activates — stays active throughout all scoring
    at(() => setState((s) => ({ ...s, activeFlowStep: 4, loopFlowStep: 4 })), t)
    t += T.INIT_PAUSE

    // ── Protocol animation loop
    for (let pi = 0; pi < PROTOCOLS.length; pi++) {
      const protoIdx = pi
      const result = results[pi]

      // Step 3 dims on ("iterating to next protocol" signal)
      at(() => setState((s) => ({ ...s, loopFlowStep: 3 })), t)
      t += T.LOOP3

      // Card slides in, loop returns to step 4 (HPMatcher)
      at(() => {
        setState((s) => ({
          ...s,
          loopFlowStep: 4,
          protocols: s.protocols.map((p, i) => (i === protoIdx ? { ...p, visible: true } : p)),
        }))
      }, t)
      t += T.CARD_SETTLE

      // ── Rules: appear as pending, then resolve
      for (let ri = 0; ri < PROTOCOLS[pi].rules.length; ri++) {
        const rule = PROTOCOLS[pi].rules[ri]
        const rr = result.ruleResults[ri]

        // 1. Add rule as PENDING (yellow)
        at(() => {
          setState((s) => ({
            ...s,
            protocols: s.protocols.map((p, i) => {
              if (i !== protoIdx) return p
              const pendingRule: RevealedRule = {
                label: rule.label,
                pass: rr.pass,
                disqualifies: rr.disqualifies,
                weight: rule.weight,
                required: rule.required,
                evalState: 'pending',
              }
              return { ...p, revealedRules: [...p.revealedRules, pendingRule] }
            }),
          }))
        }, t)
        t += T.PENDING

        // 2. Resolve rule (green pass or red fail)
        at(() => {
          setState((s) => ({
            ...s,
            protocols: s.protocols.map((p, i) => {
              if (i !== protoIdx) return p
              const lastIdx = p.revealedRules.length - 1
              const newRules = p.revealedRules.map((r, idx) =>
                idx === lastIdx ? { ...r, evalState: 'resolved' as const } : r
              )
              return {
                ...p,
                revealedRules: newRules,
                score: rr.pass ? p.score + rr.weightAdded : rr.disqualifies ? 0 : p.score,
                disqualified: p.disqualified || rr.disqualifies,
                shaking: rr.disqualifies,
              }
            }),
          }))
        }, t)
        t += T.POST_RESOLVE

        // Stop revealing more rules after a required fail
        if (rr.disqualifies) break
      }

      // Gap between protocols
      if (pi < PROTOCOLS.length - 1) t += T.INTER_PROTO
    }

    // ── Winner badge
    const winnerIdx = results.reduce((best, r, i) => (r.score > results[best].score ? i : best), 0)
    t += T.PRE_WINNER
    at(() => {
      setState((s) => ({
        ...s,
        protocols: s.protocols.map((p, i) => (i === winnerIdx ? { ...p, winner: true } : p)),
      }))
    }, t)

    // ── Advance to step 5 (Winner Selected)
    t += T.WINNER_TO_5
    at(() => {
      setState((s) => ({
        ...s,
        phase: 'complete',
        activeFlowStep: 5,
        loopFlowStep: -1,
        winnerName: PROTOCOLS[winnerIdx].label,
        winnerScore: results[winnerIdx].score,
      }))
    }, t)
  }, [selectedId])

  const selectPatient = (id: string) => {
    clearTimers()
    setSelectedId(id)
    setState(makeResetState())
  }

  const showPanel = state.activeFlowStep >= 4
  const hpActive = state.activeFlowStep === 4
  const selectedPatient = PATIENTS.find((p) => p.id === selectedId)!

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <div className="header-left">
          <div className="header-logo">DF</div>
          <div>
            <h1 className="header-title">DemoFlow</h1>
            <p className="header-sub">OHIF Hanging Protocol — Weight Scoring Visualizer</p>
          </div>
        </div>
        <div className="header-right">
          <span className="version-badge">OHIF v3.13</span>
          <span className="version-badge">HPMatcher</span>
        </div>
      </header>

      <div className="columns">
        {/* ── LEFT COLUMN ──────────────────────────────────────────────── */}
        <div className="left-col">

          {/* Patient selector */}
          <div className="panel">
            <div className="panel-label">Study</div>
            <div className="patient-list">
              {PATIENTS.map((p) => (
                <button
                  key={p.id}
                  className={`patient-row ${selectedId === p.id ? 'selected' : ''}`}
                  onClick={() => selectPatient(p.id)}
                >
                  <div className={`patient-avatar av-${p.id}`}>{p.id}</div>
                  <div className="patient-info">
                    <div className="patient-name">{p.name}</div>
                    <div className="patient-desc">{p.description}</div>
                  </div>
                  <div className={`patient-radio ${selectedId === p.id ? 'radio-on' : ''}`} />
                </button>
              ))}
            </div>
            <button
              className="run-btn"
              onClick={runAnimation}
              disabled={state.phase === 'running'}
            >
              {state.phase === 'running' ? (
                <><span className="btn-spinner" />Running…</>
              ) : (
                <><span className="btn-play">▶</span>Run Protocol Selection</>
              )}
            </button>
          </div>

          {/* Flow diagram */}
          <div className="panel">
            <div className="panel-label">Execution Flow</div>
            <div className="flow-diagram">
              {FLOW_STEPS.map((step, i) => {
                const isActive   = state.activeFlowStep === i
                const isPassed   = state.activeFlowStep > i
                // Loop glow: step 3 or 4 gets a dim secondary glow while scoring
                const isLooping  = state.loopFlowStep === i && !isActive
                const connLit    = state.activeFlowStep > i

                const showResult = step.type === 'output' && state.phase === 'complete' && !!state.winnerName

                const blockClass = [
                  'flow-block',
                  `fb-${step.type}`,
                  isActive                        ? 'fb-active'  : '',
                  isLooping                       ? 'fb-loop'    : '',
                  !isActive && !isLooping && isPassed ? 'fb-passed' : '',
                ].filter(Boolean).join(' ')

                return (
                  <div key={i} className="flow-step-wrap">
                    <div className={blockClass}>
                      <div className="fb-label">{step.label}</div>
                      <div className="fb-sub">{step.sub}</div>
                      {showResult && (
                        <div className="fb-result">
                          <span className="fb-result-arrow">→</span>
                          <span className="fb-result-name">{state.winnerName}</span>
                          <span className="fb-result-score">{state.winnerScore} pts</span>
                        </div>
                      )}
                    </div>
                    {i < FLOW_STEPS.length - 1 && (
                      <div className={`flow-conn ${connLit ? 'conn-lit' : ''}`}>
                        <div className="conn-line" />
                        <div className="conn-tip" />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

        </div>

        {/* ── RIGHT COLUMN ─────────────────────────────────────────────── */}
        <div className="right-col">
          <div className="scoring-outer">
            {!showPanel ? (
              <div className="scoring-idle">
                <div className="idle-rings">
                  <div className="idle-ring ir-1" />
                  <div className="idle-ring ir-2" />
                  <div className="idle-ring ir-3" />
                  <div className="idle-gear">⚙</div>
                </div>
                <p className="idle-text">Select a patient and run protocol selection</p>
                <p className="idle-sub">The HPMatcher scoring engine will visualize here</p>
              </div>
            ) : (
              <div className="scoring-inner">
                {/* Panel header */}
                <div className="scoring-header">
                  <div className="scoring-header-left">
                    {hpActive && <div className="live-dot" />}
                    <span className="scoring-title">HPMatcher.match()</span>
                    <span className="scoring-file">HPMatcher.js:12</span>
                  </div>
                  {hpActive && <span className="badge-eval">● EVALUATING</span>}
                  {state.phase === 'complete' && <span className="badge-done">✓ COMPLETE</span>}
                </div>

                {/* Study metadata */}
                <div className="study-meta">
                  <span className="meta-label">Study Metadata</span>
                  <div className="meta-attrs">
                    <span className="meta-attr">
                      <span className="meta-key">ModalitiesInStudy</span>
                      <span className="meta-val">['{selectedPatient.data.ModalitiesInStudy.join("', '")}']</span>
                    </span>
                    <span className="meta-sep">·</span>
                    <span className="meta-attr">
                      <span className="meta-key">displaySets</span>
                      <span className="meta-val">{selectedPatient.data.numberOfDisplaySetsWithImages}</span>
                    </span>
                    <span className="meta-sep">·</span>
                    <span className="meta-attr">
                      <span className="meta-key">hasPrior</span>
                      <span className={`meta-val ${selectedPatient.data.hasPrior ? 'meta-true' : 'meta-false'}`}>
                        {selectedPatient.data.hasPrior ? 'true' : 'false'}
                      </span>
                    </span>
                  </div>
                </div>

                {/* Protocol cards */}
                <div className="proto-list">
                  {PROTOCOLS.map((proto, pi) => {
                    const ps = state.protocols[pi]
                    if (!ps.visible) return null

                    return (
                      <div
                        key={proto.id}
                        className={[
                          'proto-card',
                          ps.disqualified ? 'pc-disq' : '',
                          ps.winner       ? 'pc-winner' : '',
                          ps.shaking      ? 'pc-shake' : '',
                        ].filter(Boolean).join(' ')}
                      >
                        {/* Card header */}
                        <div className="pc-header">
                          <div className="pc-name-row">
                            <div className={`pc-dot dot-${pi}`} />
                            <div>
                              <div className="pc-name">{proto.label}</div>
                              <div className="pc-desc">{proto.description}</div>
                            </div>
                          </div>
                          <div className="pc-score-row">
                            <span className="pc-score-label">score</span>
                            <span className={`pc-score ${ps.disqualified ? 'score-zero' : ps.score > 0 ? 'score-pos' : 'score-neutral'}`}>
                              {ps.score}
                            </span>
                            {ps.disqualified && <span className="tag tag-disq">✕ Disqualified</span>}
                            {ps.winner       && <span className="tag tag-win">🏆 Winner</span>}
                          </div>
                        </div>

                        {/* Rules */}
                        <div className="pc-rules">
                          {ps.revealedRules.map((rr, ri) => {
                            const pending = rr.evalState === 'pending'
                            return (
                              <div
                                key={ri}
                                className={`rule-row ${pending ? 'rr-pending' : rr.pass ? 'rr-pass' : 'rr-fail'}`}
                              >
                                <span className={`rule-check ${pending ? 'check-pending' : rr.pass ? 'check-pass' : 'check-fail'}`}>
                                  {pending ? '○' : rr.pass ? '✓' : '✕'}
                                </span>
                                <span className="rule-text">{rr.label}</span>
                                {rr.required && <span className="rule-req">required</span>}
                                <span className={`rule-pts ${pending ? 'pts-pending' : rr.pass ? 'pts-pass' : 'pts-fail'}`}>
                                  {pending ? `${rr.weight} wt` : rr.pass ? `+${rr.weight}` : rr.disqualifies ? 'FAIL' : '±0'}
                                </span>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>

                {/* Winner result card */}
                {state.phase === 'complete' && state.winnerName && (
                  <div className="winner-card">
                    <div className="winner-glow" />
                    <span className="winner-trophy">🏆</span>
                    <div className="winner-body">
                      <div className="winner-eyebrow">Protocol Selected</div>
                      <div className="winner-name">{state.winnerName}</div>
                      <div className="winner-score">Final score: {state.winnerScore} pts</div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
