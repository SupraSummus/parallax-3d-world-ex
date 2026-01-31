import { useEffect, useRef, useState } from 'react'
import { ParallaxRenderer, World, Camera, RenderStats, Layer } from '@/lib/renderer'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { LayerPreview } from '@/components/LayerPreview'
import {
  ArrowsOutCardinal,
  ArrowClockwise,
  Eye,
  EyeSlash,
  Cube,
  ChartLine,
  Crosshair,
  Stack
} from '@phosphor-icons/react'

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<ParallaxRenderer | null>(null)
  const animationFrameRef = useRef<number | undefined>(undefined)
  const keysPressed = useRef<Set<string>>(new Set())

  const [stats, setStats] = useState<RenderStats>({
    fps: 60,
    frameTime: 16,
    layerCount: 0,
    cacheHits: 0,
    cacheMisses: 0,
    voxelsRendered: 0
  })
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 15, z: -30 })
  const [showDebug, setShowDebug] = useState(true)
  const [showLayers, setShowLayers] = useState(true)
  const [layers, setLayers] = useState<Layer[]>([])
  const [layerSpacing, setLayerSpacing] = useState(5)
  const [moveSpeed, setMoveSpeed] = useState(0.5)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const resizeCanvas = () => {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
      if (rendererRef.current) {
        rendererRef.current.resize(window.innerWidth, window.innerHeight)
      }
    }

    resizeCanvas()
    window.addEventListener('resize', resizeCanvas)

    const world = new World()
    const renderer = new ParallaxRenderer(canvas, world)
    rendererRef.current = renderer

    const gameLoop = () => {
      if (!rendererRef.current) return

      const currentCamera = rendererRef.current.getCamera()
      let newCamera = { ...currentCamera }
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
      }

      rendererRef.current.render()
      setStats(rendererRef.current.getStats())
      setLayers(rendererRef.current.getLayers())

      animationFrameRef.current = requestAnimationFrame(gameLoop)
    }

    gameLoop()

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
      window.removeEventListener('resize', resizeCanvas)
    }
  }, [moveSpeed])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      keysPressed.current.add(key)
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      keysPressed.current.delete(key)
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [])

  const handleRegenerateWorld = () => {
    if (rendererRef.current) {
      rendererRef.current.regenerateWorld(Date.now())
    }
  }

  const handleLayerSpacingChange = (value: number[]) => {
    const spacing = value[0]
    setLayerSpacing(spacing)
    if (rendererRef.current) {
      rendererRef.current.setLayerSpacing(spacing)
    }
  }

  const handleToggleLayerVisibility = (depth: number) => {
    if (rendererRef.current) {
      rendererRef.current.toggleLayerVisibility(depth)
      setLayers(rendererRef.current.getLayers())
    }
  }

  const cacheHitRate = stats.cacheHits + stats.cacheMisses > 0
    ? Math.round((stats.cacheHits / (stats.cacheHits + stats.cacheMisses)) * 100)
    : 0

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
          2.5D Rendering with Layer Cache
        </p>
      </div>

      {showDebug && (
        <Card className="absolute top-6 right-6 p-4 bg-card/90 backdrop-blur-sm pointer-events-auto w-72">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <ChartLine className="text-primary" size={20} />
              <h2 className="font-bold text-lg">Performance</h2>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowDebug(false)}
              className="h-6 w-6 p-0"
            >
              <EyeSlash size={16} />
            </Button>
          </div>

          <div className="space-y-2 font-mono text-xs">
            <div className="flex justify-between">
              <span className="text-muted-foreground">FPS</span>
              <span className={stats.fps < 30 ? 'text-destructive' : 'text-primary'}>
                {stats.fps}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Frame Time</span>
              <span className="text-foreground">{stats.frameTime.toFixed(2)}ms</span>
            </div>

            <Separator className="my-2" />

            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Cache</span>
              <Badge variant={cacheHitRate > 70 ? 'default' : 'destructive'}>
                {cacheHitRate}%
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Hits / Misses</span>
              <span className="text-foreground">
                {stats.cacheHits} / {stats.cacheMisses}
              </span>
            </div>

            <Separator className="my-2" />

            <div className="flex justify-between">
              <span className="text-muted-foreground">Active Layers</span>
              <span className="text-primary">{stats.layerCount}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Voxels/Frame</span>
              <span className="text-foreground">{stats.voxelsRendered}</span>
            </div>
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
            <span className="text-primary">{stats.layerCount}</span>
          </div>
        </div>

        <Separator className="my-3" />

        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground mb-2 block">
              Layer Spacing: {layerSpacing}
            </label>
            <Slider
              value={[layerSpacing]}
              onValueChange={handleLayerSpacingChange}
              min={2}
              max={15}
              step={1}
              className="w-full"
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-2 block">
              Move Speed: {moveSpeed.toFixed(1)}
            </label>
            <Slider
              value={[moveSpeed]}
              onValueChange={(v) => setMoveSpeed(v[0])}
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

        <Button
          onClick={handleRegenerateWorld}
          className="w-full mb-3"
          variant="default"
        >
          <ArrowClockwise size={16} className="mr-2" />
          Regenerate World
        </Button>

        <div className="flex gap-2 mb-3">
          {!showDebug && (
            <Button
              onClick={() => setShowDebug(true)}
              className="flex-1"
              variant="outline"
            >
              <Eye size={16} className="mr-2" />
              Performance
            </Button>
          )}
          <Button
            onClick={() => setShowLayers(!showLayers)}
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
