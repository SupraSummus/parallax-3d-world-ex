/* eslint-disable @typescript-eslint/no-deprecated */
// Phosphor icon names like ChartLine are deprecated in favor of ChartLineIcon,
// but the Icon suffixed versions are not exported at package level
import { useEffect, useRef, useState, useCallback } from 'react'
import { ParallaxRenderer, World, Camera, SessionStats, Layer, WorldType, WORLD_TYPES } from '@/lib/renderer'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LayerPreview } from '@/components/LayerPreview'
import {
  ArrowsOutCardinal,
  ArrowClockwise,
  Eye,
  EyeSlash,
  Cube,
  ChartLine,
  Crosshair,
  Stack,
  ClockCounterClockwise
} from '@phosphor-icons/react'

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<ParallaxRenderer | null>(null)
  const keysPressed = useRef<Set<string>>(new Set())
  const movementInterval = useRef<number | undefined>(undefined)

  const [sessionStats, setSessionStats] = useState<SessionStats>({
    totalUpdates: 0,
    totalRenderTime: 0,
    totalLayersRegenerated: 0,
    totalVoxelsRendered: 0,
    averageCacheEfficiency: 0,
    lastUpdate: null,
    layerCount: 0,
    voxelsRendered: 0,
    cacheHits: 0,
    cacheMisses: 0,
    fps: 0,
    frameTime: 0
  })
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 15, z: -30 })
  const [showStats, setShowStats] = useState(true)
  const [showLayers, setShowLayers] = useState(true)
  const [layers, setLayers] = useState<Layer[]>([])
  const [moveSpeed, setMoveSpeed] = useState(0.5)
  const [worldType, setWorldType] = useState<WorldType>('forest')

  const requestRender = useCallback(() => {
    if (rendererRef.current) {
      rendererRef.current.render()
      setSessionStats(rendererRef.current.getSessionStats())
      setLayers(rendererRef.current.getLayers())
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const resizeCanvas = () => {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
      if (rendererRef.current) {
        rendererRef.current.resize(window.innerWidth, window.innerHeight)
        requestRender()
      }
    }

    resizeCanvas()
    window.addEventListener('resize', resizeCanvas)

    const world = new World()
    const renderer = new ParallaxRenderer(canvas, world)
    rendererRef.current = renderer

    requestRender()

    return () => {
      window.removeEventListener('resize', resizeCanvas)
    }
  }, [requestRender])

  useEffect(() => {
    const updateCamera = () => {
      if (!rendererRef.current) return

      const currentCamera = rendererRef.current.getCamera()
      const newCamera = { ...currentCamera }
      let moved = false

      if (keysPressed.current.has('w')) {
        newCamera.z += moveSpeed
        moved = true
      }
      if (keysPressed.current.has('s')) {
        newCamera.z -= moveSpeed
        moved = true
      }
      if (keysPressed.current.has('a')) {
        newCamera.x -= moveSpeed
        moved = true
      }
      if (keysPressed.current.has('d')) {
        newCamera.x += moveSpeed
        moved = true
      }
      if (keysPressed.current.has(' ')) {
        newCamera.y += moveSpeed
        moved = true
      }
      if (keysPressed.current.has('shift')) {
        newCamera.y -= moveSpeed
        moved = true
      }

      if (moved) {
        rendererRef.current.setCamera(newCamera)
        setCamera(newCamera)
        requestRender()
      }
    }

    if (keysPressed.current.size > 0) {
      movementInterval.current = window.setInterval(updateCamera, 16)
    }

    return () => {
      if (movementInterval.current) {
        clearInterval(movementInterval.current)
      }
    }
  }, [moveSpeed, requestRender])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      const wasEmpty = keysPressed.current.size === 0
      keysPressed.current.add(key)
      
      if (wasEmpty && keysPressed.current.size > 0) {
        const updateCamera = () => {
          if (!rendererRef.current) return

          const currentCamera = rendererRef.current.getCamera()
          const newCamera = { ...currentCamera }
          let moved = false

          if (keysPressed.current.has('w')) {
            newCamera.z += moveSpeed
            moved = true
          }
          if (keysPressed.current.has('s')) {
            newCamera.z -= moveSpeed
            moved = true
          }
          if (keysPressed.current.has('a')) {
            newCamera.x -= moveSpeed
            moved = true
          }
          if (keysPressed.current.has('d')) {
            newCamera.x += moveSpeed
            moved = true
          }
          if (keysPressed.current.has(' ')) {
            newCamera.y += moveSpeed
            moved = true
          }
          if (keysPressed.current.has('shift')) {
            newCamera.y -= moveSpeed
            moved = true
          }

          if (moved) {
            rendererRef.current.setCamera(newCamera)
            setCamera(newCamera)
            requestRender()
          }
        }

        movementInterval.current = window.setInterval(updateCamera, 16)
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      keysPressed.current.delete(key)
      
      if (keysPressed.current.size === 0 && movementInterval.current) {
        clearInterval(movementInterval.current)
        movementInterval.current = undefined
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      if (movementInterval.current) {
        clearInterval(movementInterval.current)
      }
    }
  }, [moveSpeed, requestRender])

  const handleRegenerateWorld = () => {
    if (rendererRef.current) {
      rendererRef.current.regenerateWorld(Date.now(), worldType)
      requestRender()
    }
  }

  const handleWorldTypeChange = (newWorldType: WorldType) => {
    setWorldType(newWorldType)
    if (rendererRef.current) {
      rendererRef.current.regenerateWorld(Date.now(), newWorldType)
      requestRender()
    }
  }

  const handleToggleLayerVisibility = (depth: number) => {
    if (rendererRef.current) {
      rendererRef.current.toggleLayerVisibility(depth)
      requestRender()
    }
  }

  const lastUpdate = sessionStats.lastUpdate
  const avgRenderTime = sessionStats.totalUpdates > 0 
    ? (sessionStats.totalRenderTime / sessionStats.totalUpdates).toFixed(2)
    : '0.00'

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-background">
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
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
              <EyeSlash size={16} />
            </Button>
          </div>

          <div className="space-y-3">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <ClockCounterClockwise size={16} className="text-muted-foreground" />
                <h3 className="text-sm font-semibold">Session Total</h3>
              </div>
              <div className="space-y-1.5 font-mono text-xs pl-6">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total Updates</span>
                  <span className="text-primary font-bold">{sessionStats.totalUpdates}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Avg Render Time</span>
                  <span className="text-foreground">{avgRenderTime}ms</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Avg Cache Efficiency</span>
                  <Badge variant={sessionStats.averageCacheEfficiency > 70 ? 'default' : 'secondary'}>
                    {sessionStats.averageCacheEfficiency.toFixed(1)}%
                  </Badge>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total Voxels</span>
                  <span className="text-foreground">{sessionStats.totalVoxelsRendered.toLocaleString()}</span>
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
        </div>
      </Card>

      <Card className="absolute bottom-6 right-6 p-4 bg-card/90 backdrop-blur-sm pointer-events-auto w-72">
        <div className="flex items-center gap-2 mb-3">
          <Cube className="text-primary" size={20} />
          <h2 className="font-bold text-lg">World</h2>
        </div>

        <div className="mb-3">
          <label className="text-xs text-muted-foreground mb-2 block">
            World Type
          </label>
          <Select value={worldType} onValueChange={handleWorldTypeChange}>
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
          onClick={handleRegenerateWorld}
          className="w-full mb-3"
          variant="default"
        >
          <ArrowClockwise size={16} className="mr-2" />
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
            {showLayers ? <EyeSlash size={16} className="mr-2" /> : <Stack size={16} className="mr-2" />}
            {showLayers ? 'Hide' : 'Show'} Layers
          </Button>
        </div>

        <Separator className="my-3" />

        <div className="text-xs text-muted-foreground space-y-1">
          <div className="flex items-center gap-2">
            <ArrowsOutCardinal size={14} />
            <span>WASD - Move Horizontally</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3.5" />
            <span>Space/Shift - Up/Down</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3.5" />
            <span>W/S also moves In/Out</span>
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
