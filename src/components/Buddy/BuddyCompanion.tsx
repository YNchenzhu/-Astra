import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  LocateFixed,
  Mic,
  MicOff,
  Power,
  Settings,
  Smile,
  Sparkles,
  UserRound,
  X,
  Heart,
} from 'lucide-react'
import {
  useBuddyStore,
  PERSONAS,
  MOODS,
  MOOD_EMOJI,
  RAINBOW_COLORS,
  SPECIES_EMOJI,
  RARITY_STARS,
  RARITY_COLORS,
  type BuddyMood,
} from '../../stores/useBuddyStore'
import { renderSprite } from './sprites'
import type { Eye, Hat } from '../../../electron/buddy/types'
import './buddy.css'
import { queueMirrorRendererPrefsToDisk } from '../../services/rendererPrefsSync'
import {
  BUDDY_SETTINGS_PANEL_HEIGHT_ESTIMATE_PX,
  BUDDY_SETTINGS_PANEL_WIDTH_ESTIMATE_PX,
} from '../../constants/buddyUi'

type SettingsView = 'menu' | 'profile' | 'mood' | 'companion'

const BuddyCompanion: React.FC = () => {
  const {
    enabled,
    muted,
    name,
    persona,
    emoji,
    mood,
    bubbleText,
    bubbleVisible,
    bubbleOpacity,
    settingsOpen,
    species,
    rarity,
    shiny,
    hat,
    eye,
    stats,
    spriteFrame,
    isBlinking,
    petHearts,
    petting,
    showTeaser,
    initialize,
    hatch,
    toggleEnabled,
    toggleMuted,
    setMood,
    applyPersona,
    updateName,
    openSettings,
    closeSettings,
    petBuddy,
    dismissTeaser,
    startAnimation,
    stopAnimation,
  } = useBuddyStore()

  const rootRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef({ dragging: false, moved: false, ox: 0, oy: 0, sx: 0, sy: 0 })
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [view, setView] = useState<SettingsView>('menu')
  const [nameDraft, setNameDraft] = useState(name)
  const [personaDraft, setPersonaDraft] = useState(0)
  const [moodDraft, setMoodDraft] = useState<BuddyMood>(mood)
  const [snapping, setSnapping] = useState(false)
  const [panelFlipV, setPanelFlipV] = useState<'up' | 'down'>('up')
  const [panelFlipH, setPanelFlipH] = useState<'left' | 'right'>('left')
  const snapTimerRef = useRef<number | null>(null)
  const branchLoggedRef = useRef(false)

  const currentPersonaIndex = useMemo(() => {
    const idx = PERSONAS.findIndex((p) => p.persona === persona && p.emoji === emoji)
    return idx >= 0 ? idx : 0
  }, [persona, emoji])

  // Initialize and start animation
  useEffect(() => {
    void initialize()
  }, [initialize])

  useEffect(() => {
    if (enabled) {
      startAnimation()
    }
    return () => { stopAnimation() }
  }, [enabled, startAnimation, stopAnimation])

  // Position persistence
  useEffect(() => {
    try {
      const saved = localStorage.getItem('buddy-pos')
      if (saved) {
        const parsed = JSON.parse(saved) as { x?: number; y?: number }
        const x = typeof parsed?.x === 'number' ? parsed.x : null
        const y = typeof parsed?.y === 'number' ? parsed.y : null
        const clampedPos = x !== null && y !== null
          ? {
              x: Math.max(0, Math.min(x, window.innerWidth - 56)),
              y: Math.max(0, Math.min(y, window.innerHeight - 56)),
            }
          : null
        if (clampedPos) {
          setPos(clampedPos)
          localStorage.setItem('buddy-pos', JSON.stringify(clampedPos))
          queueMirrorRendererPrefsToDisk()
        } else {
          setPos(null)
          localStorage.removeItem('buddy-pos')
          queueMirrorRendererPrefsToDisk()
        }
      }
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    if (branchLoggedRef.current) return
    branchLoggedRef.current = true
  }, [enabled, showTeaser, species, pos])

  // Persist position with a short debounce — pointermove fires at 60-120Hz
  // during drag and writing to localStorage on every frame caused visible
  // jank (sync disk I/O blocks the renderer thread).
  const persistPosTimerRef = useRef<number | null>(null)
  useEffect(() => {
    if (!pos) return
    if (persistPosTimerRef.current !== null) {
      window.clearTimeout(persistPosTimerRef.current)
    }
    persistPosTimerRef.current = window.setTimeout(() => {
      persistPosTimerRef.current = null
      localStorage.setItem('buddy-pos', JSON.stringify(pos))
      queueMirrorRendererPrefsToDisk()
    }, 150)
    return () => {
      if (persistPosTimerRef.current !== null) {
        window.clearTimeout(persistPosTimerRef.current)
        persistPosTimerRef.current = null
      }
    }
  }, [pos])

  const resetDrafts = useCallback(() => {
    setNameDraft(name)
    setPersonaDraft(currentPersonaIndex)
    setMoodDraft(mood)
  }, [name, currentPersonaIndex, mood])

  useEffect(() => {
    if (!settingsOpen) return
    resetDrafts()
    setView('menu')
  }, [settingsOpen, resetDrafts])

  const closePanel = useCallback(() => {
    closeSettings()
    setView('menu')
  }, [closeSettings])

  // Close panel on outside click
  useEffect(() => {
    if (!settingsOpen) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (!target || !rootRef.current) return
      if (!rootRef.current.contains(target)) {
        closePanel()
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [settingsOpen, closePanel])

  // Drag handlers
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!rootRef.current) return
    const rect = rootRef.current.getBoundingClientRect()
    dragRef.current = {
      dragging: true,
      moved: false,
      ox: e.clientX - rect.left,
      oy: e.clientY - rect.top,
      sx: e.clientX,
      sy: e.clientY,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.dragging) return
    if (snapping) setSnapping(false)

    const dx = Math.abs(e.clientX - dragRef.current.sx)
    const dy = Math.abs(e.clientY - dragRef.current.sy)
    if (dx > 3 || dy > 3) {
      dragRef.current.moved = true
    }

    const x = e.clientX - dragRef.current.ox
    const y = e.clientY - dragRef.current.oy
    setPos({
      x: Math.max(0, Math.min(x, window.innerWidth - 56)),
      y: Math.max(0, Math.min(y, window.innerHeight - 56)),
    })
  }, [snapping])

  const snapToEdge = useCallback((x: number, y: number) => {
    const w = window.innerWidth
    const margin = 16
    const distLeft = x
    const distRight = w - (x + 56)
    const snapX = distLeft < distRight ? margin : w - margin - 56
    const snapY = Math.max(margin, Math.min(y, window.innerHeight - margin - 56))
    return { x: snapX, y: snapY }
  }, [])

  const onPointerUp = useCallback(() => {
    if (dragRef.current.dragging && dragRef.current.moved && pos) {
      const snapped = snapToEdge(pos.x, pos.y)
      setSnapping(true)
      setPos(snapped)
      if (snapTimerRef.current) window.clearTimeout(snapTimerRef.current)
      snapTimerRef.current = window.setTimeout(() => setSnapping(false), 300)
    }
    dragRef.current.dragging = false
  }, [pos, snapToEdge])

  const openPanel = useCallback(() => {
    openSettings()
    setView('menu')
  }, [openSettings])

  const saveProfile = useCallback(async () => {
    const trimmed = nameDraft.trim()
    if (personaDraft !== currentPersonaIndex) {
      await applyPersona(personaDraft)
    }
    if (trimmed && trimmed !== name) {
      await updateName(trimmed)
    }
    setView('menu')
  }, [nameDraft, personaDraft, currentPersonaIndex, applyPersona, updateName, name])

  const saveMood = useCallback(async () => {
    if (moodDraft !== mood) {
      await setMood(moodDraft)
    }
    setView('menu')
  }, [moodDraft, mood, setMood])

  const resetPosition = useCallback(() => {
    if (snapTimerRef.current) window.clearTimeout(snapTimerRef.current)
    setSnapping(false)
    setPos(null)
    localStorage.removeItem('buddy-pos')
  }, [])

  // Panel flip calculation
  useEffect(() => {
    if (!settingsOpen || !rootRef.current) return
    const rect = rootRef.current.getBoundingClientRect()
    const roomBelow = window.innerHeight - rect.bottom
    const roomAbove = rect.top
    setPanelFlipV(
      roomBelow >= BUDDY_SETTINGS_PANEL_HEIGHT_ESTIMATE_PX
        ? 'down'
        : roomAbove >= BUDDY_SETTINGS_PANEL_HEIGHT_ESTIMATE_PX
          ? 'up'
          : roomAbove > roomBelow
            ? 'up'
            : 'down',
    )
    const roomRight = window.innerWidth - rect.left
    const roomLeft = rect.right
    setPanelFlipH(
      roomRight >= BUDDY_SETTINGS_PANEL_WIDTH_ESTIMATE_PX
        ? 'right'
        : roomLeft >= BUDDY_SETTINGS_PANEL_WIDTH_ESTIMATE_PX
          ? 'left'
          : roomRight > roomLeft
            ? 'right'
            : 'left',
    )
  }, [settingsOpen])

  useEffect(() => {
    return () => {
      if (snapTimerRef.current) window.clearTimeout(snapTimerRef.current)
    }
  }, [])

  const style: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }
    : {}

  const hasCompanion = !!species
  const speciesClass = hasCompanion && species ? `species-${species}` : 'species-default'
  const rarityClass = rarity ? `rarity-${rarity}` : 'rarity-common'

  return (
    <div className={`buddy-root${snapping ? ' snapping' : ''}`} ref={rootRef} style={style}>
      {/* Teaser notification */}
      {showTeaser && !enabled && (
        <div className="buddy-teaser" onClick={() => dismissTeaser()}>
          <span className="buddy-teaser-text">
            {'/buddy'.split('').map((ch, i) => (
              <span key={i} style={{ color: RAINBOW_COLORS[i % RAINBOW_COLORS.length] }}>{ch}</span>
            ))}
          </span>
          <span className="buddy-teaser-sub">点击孵化你的伴生兽！</span>
        </div>
      )}

      {!enabled ? (
        <button className="buddy-hatch" onClick={() => hatch()} title="启动伴随式 AI 角色">
          <Sparkles size={14} />
          <span>启动 Buddy</span>
        </button>
      ) : (
        <>
          {/* Speech bubble with fade */}
          {bubbleVisible && bubbleText && (
            <div
              className="buddy-bubble"
              style={{
                opacity: bubbleOpacity,
                transition: 'opacity 0.3s ease',
              }}
            >
              <div className="buddy-bubble-title">
                {name}
                {rarity && (
                  <span
                    className="buddy-bubble-rarity"
                    style={{ color: RARITY_COLORS[rarity] }}
                  >
                    {RARITY_STARS[rarity]}
                  </span>
                )}
                {shiny && <span className="buddy-bubble-shiny">✨</span>}
              </div>
              <div className="buddy-bubble-text">{bubbleText}</div>
              {/* Speech tail */}
              <div className="buddy-bubble-tail" />
            </div>
          )}

          {/* Pet hearts */}
          {petHearts.map((heart) => (
            <div
              key={heart.id}
              className="buddy-pet-heart"
              style={{
                left: `${heart.x}px`,
                // `Date.now()` during render is intentional: we want
                // the CSS animation to advance by real wall-clock time
                // since the heart was spawned, so a remount (e.g. tab
                // focus flip) doesn't restart the animation from zero.
                // eslint-disable-next-line react-hooks/purity
                animationDelay: `${(Date.now() - heart.startTime) / 1000}s`,
              }}
            >
              {heart.emoji}
            </div>
          ))}

          {/* Settings panel */}
          {settingsOpen && (
            <div className={`buddy-settings flip-v-${panelFlipV} flip-h-${panelFlipH}`}>
              <div className="buddy-settings-header">
                {view === 'menu' ? (
                  <span className="buddy-settings-spacer" />
                ) : (
                  <button className="buddy-settings-back" onClick={() => setView('menu')} title="返回">
                    <ChevronLeft size={14} />
                  </button>
                )}
                <span className="buddy-settings-title">
                  {view === 'menu' ? 'Buddy 设置'
                    : view === 'profile' ? '人格与名称'
                    : view === 'companion' ? '伴生兽信息'
                    : '心情设置'}
                </span>
                <button className="buddy-settings-close" onClick={closePanel} title="关闭">
                  <X size={14} />
                </button>
              </div>

              {view === 'menu' && (
                <div className="buddy-settings-menu">
                  {/* Companion info button */}
                  {hasCompanion && (
                    <button className="buddy-menu-item" onClick={() => setView('companion')}>
                      <div className="buddy-menu-left">
                        <Heart size={14} />
                        <div className="buddy-menu-text">
                          <span className="buddy-menu-title">{name}</span>
                          <span className="buddy-menu-desc">
                            {SPECIES_EMOJI[species as keyof typeof SPECIES_EMOJI] || emoji} {species}
                            {rarity ? ` ${RARITY_STARS[rarity]}` : ''}
                            {shiny ? ' ✨' : ''}
                          </span>
                        </div>
                      </div>
                      <ChevronRight size={14} />
                    </button>
                  )}

                  <button className="buddy-menu-item" onClick={() => setView('profile')}>
                    <div className="buddy-menu-left">
                      <UserRound size={14} />
                      <div className="buddy-menu-text">
                        <span className="buddy-menu-title">人格与名称</span>
                        <span className="buddy-menu-desc">{name} · {persona}</span>
                      </div>
                    </div>
                    <ChevronRight size={14} />
                  </button>

                  <button className="buddy-menu-item" onClick={() => setView('mood')}>
                    <div className="buddy-menu-left">
                      <Smile size={14} />
                      <div className="buddy-menu-text">
                        <span className="buddy-menu-title">心情设置</span>
                        <span className="buddy-menu-desc">当前：{mood}</span>
                      </div>
                    </div>
                    <ChevronRight size={14} />
                  </button>

                  {/* Pet button */}
                  <button className="buddy-menu-item" onClick={() => petBuddy()}>
                    <div className="buddy-menu-left">
                      <Heart size={14} />
                      <div className="buddy-menu-text">
                        <span className="buddy-menu-title">抚摸 Buddy</span>
                        <span className="buddy-menu-desc">表达喜爱</span>
                      </div>
                    </div>
                  </button>

                  {pos && (
                    <button className="buddy-menu-item" onClick={resetPosition}>
                      <div className="buddy-menu-left">
                        <LocateFixed size={14} />
                        <div className="buddy-menu-text">
                          <span className="buddy-menu-title">复位位置</span>
                          <span className="buddy-menu-desc">回到默认右下角</span>
                        </div>
                      </div>
                    </button>
                  )}
                </div>
              )}

              {view === 'companion' && stats && (
                <div className="buddy-settings-body">
                  <div className="buddy-companion-card">
                    <div className="buddy-companion-header">
                      <span className="buddy-companion-emoji">
                        {SPECIES_EMOJI[species as keyof typeof SPECIES_EMOJI] || emoji}
                      </span>
                      <div>
                        <div className="buddy-companion-name">{name}</div>
                        <div className="buddy-companion-species">
                          {species}
                          {rarity && (
                            <span style={{ color: RARITY_COLORS[rarity] }}>
                              {' '}{RARITY_STARS[rarity]}
                            </span>
                          )}
                          {shiny && <span> ✨</span>}
                        </div>
                        <div className="buddy-companion-traits">
                          {eye && <div className="buddy-companion-eye">👁️ {eye}</div>}
                          {hat && hat !== 'none' && (
                            <div className="buddy-companion-hat">🎩 {hat}</div>
                          )}
                          <div className="buddy-companion-shiny">闪光：{shiny ? '是' : '否'}</div>
                        </div>
                      </div>
                    </div>
                    <div className="buddy-companion-stats">
                      {Object.entries(stats).map(([key, val]) => (
                        <div key={key} className="buddy-stat">
                          <span className="buddy-stat-name">{key}</span>
                          <div className="buddy-stat-bar">
                            <div
                              className="buddy-stat-fill"
                              style={{
                                width: `${val}%`,
                                backgroundColor: val >= 70 ? '#22c55e' : val >= 40 ? '#f59e0b' : '#ef4444',
                              }}
                            />
                          </div>
                          <span className="buddy-stat-value">{val}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <button
                    className="buddy-panel-btn"
                    onClick={() => setView('menu')}
                  >
                    返回
                  </button>
                </div>
              )}

              {view === 'profile' && (
                <div className="buddy-settings-body">
                  <label className="buddy-field">
                    <span className="buddy-field-label">显示名称</span>
                    <input
                      className="buddy-field-input"
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                    />
                  </label>

                  <div className="buddy-field">
                    <span className="buddy-field-label">人格选择</span>
                    <div className="buddy-persona-grid">
                      {PERSONAS.map((p, i) => (
                        <button
                          key={p.persona}
                          className={`buddy-persona-chip${i === personaDraft ? ' active' : ''}`}
                          onClick={() => setPersonaDraft(i)}
                          title={p.persona}
                        >
                          <span>{p.emoji}</span>
                          <span>{p.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="buddy-panel-actions">
                    <button className="buddy-panel-btn" onClick={() => { resetDrafts(); setView('menu') }}>
                      取消
                    </button>
                    <button className="buddy-panel-btn primary" onClick={() => void saveProfile()}>
                      保存
                    </button>
                  </div>
                </div>
              )}

              {view === 'mood' && (
                <div className="buddy-settings-body">
                  <div className="buddy-field">
                    <span className="buddy-field-label">选择当前心情</span>
                    <div className="buddy-mood-row">
                      {MOODS.map((m) => (
                        <button
                          key={m}
                          className={`buddy-mood-chip${moodDraft === m ? ' active' : ''}`}
                          onClick={() => setMoodDraft(m)}
                          title={m}
                        >
                          <span>{MOOD_EMOJI[m]}</span>
                          <span>{m}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="buddy-panel-actions">
                    <button
                      className="buddy-panel-btn"
                      onClick={() => { setMoodDraft(mood); setView('menu') }}
                    >
                      取消
                    </button>
                    <button className="buddy-panel-btn primary" onClick={() => void saveMood()}>
                      保存
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Avatar with ASCII sprite */}
          <div
            className={`buddy-avatar ${speciesClass} ${rarityClass} mood-${mood}${petting ? ' petting' : ''}`}
            title={`${name} · ${persona}\n拖拽移动`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={() => petBuddy()}
          >
            <div className="buddy-avatar-aura" />
            {hasCompanion && species ? (
              <div className={`buddy-sprite ${speciesClass}`}>
                {renderSprite(species, (eye || '·') as Eye, (hat || 'none') as Hat, spriteFrame).map((line, i) => (
                  <span key={i} className={`buddy-sprite-line${isBlinking ? ' blink' : ''}`}>
                    {line || '\u00A0'}
                  </span>
                ))}
              </div>
            ) : (
              <span className={isBlinking ? 'buddy-avatar-blink' : ''}>
                {emoji}
              </span>
            )}
          </div>

          {/* Action buttons */}
          <div className="buddy-actions">
            <button onClick={openPanel} title="Buddy 设置">
              <Settings size={12} />
            </button>
            <button onClick={() => toggleEnabled()} title="关闭 Buddy">
              <Power size={12} />
            </button>
            <button onClick={() => toggleMuted()} title={muted ? '取消静音' : '静音'}>
              {muted ? <MicOff size={12} /> : <Mic size={12} />}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export { BuddyCompanion }
