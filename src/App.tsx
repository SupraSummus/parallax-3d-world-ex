import { useEffect, useRef, useState, useCallback } from 'react'
import { ParallaxRenderer, DEFAULT_CAMERA, type Camera, type Layer, type SessionStats } from '@/lib/renderer'
import { World, WORLD_TYPES, type WorldType } from '@/lib/world'
import { DEFAULT_DEPTH_MULTIPLIER, MAX_DEPTH_MULTIPLIER, MIN_DEPTH_MULTIPLIER } from '@/lib/slice-selection'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LayerPreview } from '@/components/LayerPreview'
import { Box, ChartLine, Crosshair, Eye, EyeOff, History, Layers, Move, RefreshCw } from 'lucide-react'

/** Key -> movement direction (x, y, z) for held keys. Keys are lower-cased. */
const MOVEMENT_KEYS: Record<string, [number, number, number]> = {
  w: [0, 0, 1],
  s: [0, 0, -1],
  a: [-1, 0, 0],
  d: [1, 0, 0],
  ' ': [0, 1, 0],
  shift: [0, -1, 0],
}

function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<ParallaxRenderer | null>(null)

  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null)
  const [camera, setCamera] = useState<Camera>(DEFAULT_CAMERA)
  const [showStats, setShowStats] = useState(true)
  const [showLayers, setShowLayers] = useState(true)
  const [layers, setLayers] = useState<Layer[]>([])
  const [moveSpeed, setMoveSpeed] = useState(0.5)
  const [worldType, setWorldType] = useState<WorldType>('forest')
  const [depthMultiplier, setDepthMultiplier] = useState(DEFAULT_DEPTH_MULTIPLIER)

  // Read from the movement loop without restarting it.
  const moveSpeedRef = useRef(moveSpeed)
  moveSpeedRef.current = moveSpeed

  const requestRender = useCallback(() => {
    const renderer = rendererRef.current
    if (!renderer) return
    renderer.render()
    setSessionStats(renderer.getStats())
    setLayers(renderer.getLayers())
    setCamera(renderer.getCamera())
  }, [])

  // Renderer lifecycle.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const renderer = new ParallaxRenderer(container, new World(Date.now(), 'forest'))
    rendererRef.current = renderer

    const handleResize = () => {
      renderer.resize(window.innerWidth, window.innerHeight)
      requestRender()
    }
    handleResize()

    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      rendererRef.current = null
    }
  }, [requestRender])

  // Keyboard movement: one animation-frame loop runs while any movement key is held.
  useEffect(() => {
    const held = new Set<string>()
    let frame: number | undefined

    const tick = () => {
      if (held.size === 0) {
        frame = undefined
        return
      }
      const renderer = rendererRef.current
      if (renderer) {
        const speed = moveSpeedRef.current
        const cam = renderer.getCamera()
        for (const key of held) {
          const [dx, dy, dz] = MOVEMENT_KEYS[key]
          cam.x += dx * speed
          cam.y += dy * speed
          cam.z += dz * speed
        }
        renderer.setCamera(cam)
        requestRender()
      }
      frame = requestAnimationFrame(tick)
    }

    const stop = () => {
      held.clear()
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = undefined
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if (!(key in MOVEMENT_KEYS)) return
      // Don't hijack typing/space activation inside form controls.
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [role="combobox"]')) return
      e.preventDefault()
      held.add(key)
      frame ??= requestAnimationFrame(tick)
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      held.delete(e.key.toLowerCase())
      if (held.size === 0) stop()
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    // Releasing keys while the window is unfocused never fires keyup.
    window.addEventListener('blur', stop)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', stop)
      stop()
    }
  }, [requestRender])

  const handleRegenerateWorld = (type: WorldType = worldType) => {
    setWorldType(type)
    rendererRef.current?.regenerateWorld(Date.now(), type)
    requestRender()
  }

  const handleToggleLayerVisibility = (depth: number) => {
    rendererRef.current?.toggleLayerVisibility(depth)
    requestRender()
  }

  const handleDepthMultiplierChange = ([value]: number[]) => {
    setDepthMultiplier(value)
    rendererRef.current?.setDepthMultiplier(value)
    requestRender()
  }

  const totalUpdates = sessionStats?.totalUpdates ?? 0
  const averageCacheEfficiency = sessionStats?.averageCacheEfficiency ?? 0
  const lastUpdate = sessionStats?.lastUpdate
  const avgRenderTime = totalUpdates > 0 && sessionStats
    ? (sessionStats.totalRenderTime / totalUpdates).toFixed(2)
    : '0.00'

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-background">
      <div
        ref={containerRef}
        className="absolute inset-0 overflow-hidden"
      />

      <div className="absolute top-6 left-6 pointer-events-none">
        <h1 className="text-4xl font-bold font-mono text-primary tracking-tight">
          PARALLAX ENGINE
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Event-Driven 2.5D Rendering
        </p>
      </div>

      {showStats && (
        <Card className="absolute top-6 right-6 p-4 bg-card/90 backdrop-blur-sm pointer-events-auto w-80">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <ChartLine className="text-primary" size={20} />
              <h2 className="font-bold text-lg">Render Statistics</h2>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setShowStats(false) }}
              className="h-6 w-6 p-0"
              aria-label="Hide statistics"
            >
              <EyeOff size={16} />
            </Button>
          </div>

          <div className="space-y-3">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <History size={16} className="text-muted-foreground" />
                <h3 className="text-sm font-semibold">Session Total</h3>
              </div>
              <div className="space-y-1.5 font-mono text-xs pl-6">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total Updates</span>
                  <span className="text-primary font-bold">{totalUpdates}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Avg Render Time</span>
                  <span className="text-foreground">{avgRenderTime}ms</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Avg Cache Efficiency</span>
                  <Badge variant={averageCacheEfficiency > 70 ? 'default' : 'secondary'}>
                    {averageCacheEfficiency.toFixed(1)}%
                  </Badge>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total Voxels</span>
                  <span className="text-foreground">{(sessionStats?.totalVoxelsRendered ?? 0).toLocaleString()}</span>
                </div>
              </div>
            </div>

            {lastUpdate && (
              <>
                <Separator />
                <div>
                  <h3 className="text-sm font-semibold mb-2">Last Update</h3>
                  <div className="space-y-1.5 font-mono text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Render Time</span>
                      <span className="text-foreground">{lastUpdate.renderTime.toFixed(2)}ms</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Active Layers</span>
                      <span className="text-primary">{lastUpdate.layerCount}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Reused / Regenerated</span>
                      <span className="text-foreground">
                        <span className="text-accent">{lastUpdate.layersReused}</span> / <span className="text-destructive">{lastUpdate.layersRegenerated}</span>
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Cache Efficiency</span>
                      <Badge variant={lastUpdate.cacheEfficiency > 70 ? 'default' : 'secondary'}>
                        {lastUpdate.cacheEfficiency.toFixed(1)}%
                      </Badge>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Voxels Rendered</span>
                      <span className="text-foreground">{lastUpdate.voxelsRendered.toLocaleString()}</span>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </Card>
      )}

      <Card className="absolute bottom-6 left-6 p-4 bg-card/90 backdrop-blur-sm pointer-events-auto w-72">
        <div className="flex items-center gap-2 mb-3">
          <Crosshair className="text-primary" size={20} />
          <h2 className="font-bold text-lg">Camera</h2>
        </div>

        <div className="space-y-2 font-mono text-xs mb-4">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Position</span>
            <span className="text-foreground">
              {camera.x.toFixed(1)}, {camera.y.toFixed(1)}, {camera.z.toFixed(1)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Active Layers</span>
            <span className="text-primary">{layers.length}</span>
          </div>
        </div>

        <Separator className="my-3" />

        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground mb-2 block">
              Move Speed: {moveSpeed.toFixed(1)}
            </label>
            <Slider
              value={[moveSpeed]}
              onValueChange={(v) => { setMoveSpeed(v[0]) }}
              min={0.1}
              max={2}
              step={0.1}
              className="w-full"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-2 block">
              Depth Multiplier: {depthMultiplier.toFixed(1)}
            </label>
            <Slider
              value={[depthMultiplier]}
              onValueChange={handleDepthMultiplierChange}
              min={MIN_DEPTH_MULTIPLIER}
              max={MAX_DEPTH_MULTIPLIER}
              step={0.1}
              className="w-full"
            />
          </div>
        </div>
      </Card>

      <Card className="absolute bottom-6 right-6 p-4 bg-card/90 backdrop-blur-sm pointer-events-auto w-72">
        <div className="flex items-center gap-2 mb-3">
          <Box className="text-primary" size={20} />
          <h2 className="font-bold text-lg">World</h2>
        </div>

        <div className="mb-3">
          <label className="text-xs text-muted-foreground mb-2 block">
            World Type
          </label>
          <Select value={worldType} onValueChange={(v) => { handleRegenerateWorld(v as WorldType) }}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select world type" />
            </SelectTrigger>
            <SelectContent>
              {WORLD_TYPES.map((type) => (
                <SelectItem key={type.value} value={type.value}>
                  {type.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          onClick={() => { handleRegenerateWorld() }}
          className="w-full mb-3"
          variant="default"
        >
          <RefreshCw size={16} className="mr-2" />
          Regenerate World
        </Button>

        <div className="flex gap-2 mb-3">
          {!showStats && (
            <Button
              onClick={() => { setShowStats(true) }}
              className="flex-1"
              variant="outline"
            >
              <Eye size={16} className="mr-2" />
              Stats
            </Button>
          )}
          <Button
            onClick={() => { setShowLayers(!showLayers) }}
            className="flex-1"
            variant="outline"
          >
            {showLayers ? <EyeOff size={16} className="mr-2" /> : <Layers size={16} className="mr-2" />}
            {showLayers ? 'Hide' : 'Show'} Layers
          </Button>
        </div>

        <Separator className="my-3" />

        <div className="text-xs text-muted-foreground space-y-1">
          <div className="flex items-center gap-2">
            <Move size={14} />
            <span>W/S - Forward/Back</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3.5" />
            <span>A/D - Left/Right</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3.5" />
            <span>Space/Shift - Up/Down</span>
          </div>
        </div>
      </Card>

      {showLayers && (
        <div className="absolute top-6 left-1/2 -translate-x-1/2 pointer-events-auto">
          <LayerPreview 
            layers={layers}
            onToggleVisibility={handleToggleLayerVisibility}
          />
        </div>
      )}

      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none">
        <Crosshair size={24} className="text-primary/50" />
      </div>
    </div>
  )
}

export default App
