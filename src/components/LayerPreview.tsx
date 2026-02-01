/* eslint-disable @typescript-eslint/no-deprecated */
// Phosphor icon names like Stack are deprecated in favor of StackIcon,
// but the Icon suffixed versions are not exported at package level
import { useEffect, useRef } from 'react'
import { Layer } from '@/lib/renderer'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Stack, Eye, EyeSlash } from '@phosphor-icons/react'

interface LayerPreviewProps {
  layers: Layer[]
  onToggleVisibility: (depth: number) => void
}

interface LayerItemProps {
  layer: Layer
  onToggleVisibility: (depth: number) => void
}

function LayerItem({ layer, onToggleVisibility }: LayerItemProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const scale = 0.15

    canvas.width = layer.canvas.width * scale
    canvas.height = layer.canvas.height * scale

    ctx.drawImage(layer.canvas, 0, 0, canvas.width, canvas.height)
  }, [layer.canvas, layer.dirty])

  const voxelCount = layer.voxels.length
  const depthRange = layer.size === 1 
    ? String(layer.depth) 
    : `${String(layer.depth)} to ${String(layer.depth + layer.size - 1)}`

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors">
      <div className="relative flex-shrink-0">
        <canvas
          ref={canvasRef}
          className="rounded border border-border w-[120px] h-[80px] bg-background/50"
          style={{
            imageRendering: 'pixelated',
            opacity: layer.visible ? 1 : 0.3
          }}
        />
        {!layer.visible && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/50 rounded">
            <EyeSlash size={24} className="text-muted-foreground" />
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="font-mono text-sm font-bold text-foreground">
              Layer {layer.depth}
            </h3>
            <Badge variant="outline" className="text-xs font-mono">
              z: {depthRange}
            </Badge>
          </div>
          <Switch
            checked={layer.visible}
            onCheckedChange={() => { onToggleVisibility(layer.depth) }}
            className="data-[state=checked]:bg-primary"
          />
        </div>

        <div className="flex items-center gap-4 text-xs text-muted-foreground font-mono">
          <span>Size: {layer.size}</span>
          <span>•</span>
          <span>{voxelCount} voxels</span>
        </div>
      </div>
    </div>
  )
}

export function LayerPreview({ layers, onToggleVisibility }: LayerPreviewProps) {
  const visibleCount = layers.filter(l => l.visible).length
  const totalCount = layers.length

  return (
    <Card className="bg-card/90 backdrop-blur-sm w-80 flex flex-col max-h-[calc(100vh-48px)]">
      <div className="p-4 pb-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Stack className="text-primary" size={20} />
            <h2 className="font-bold text-lg">Layers</h2>
          </div>
          <Badge variant="secondary" className="font-mono text-xs">
            {visibleCount}/{totalCount}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Progressive depth slices
        </p>
      </div>

      <Separator />

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-2">
          {layers.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              No layers rendered yet
            </div>
          ) : (
            layers.map(layer => (
              <LayerItem
                key={layer.depth}
                layer={layer}
                onToggleVisibility={onToggleVisibility}
              />
            ))
          )}
        </div>
      </ScrollArea>

      <Separator />

      <div className="p-3 space-y-1 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <Eye size={14} />
          <span>Toggle visibility to inspect layers</span>
        </div>
      </div>
    </Card>
  )
}
