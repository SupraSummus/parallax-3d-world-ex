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
import { Stack } from '@phosphor-icons/react'

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
    const scale = 0.1

    canvas.width = layer.canvas.width * scale
    canvas.height = layer.canvas.height * scale

    ctx.drawImage(layer.canvas, 0, 0, canvas.width, canvas.height)
  }, [layer.canvas, layer.dirty])

  const depthRange = layer.size === 1
    ? String(layer.depth)
    : `${String(layer.depth)}–${String(layer.depth + layer.size - 1)}`

  return (
    <div className="flex items-center gap-2 p-1.5 rounded-md bg-muted/30 hover:bg-muted/50 transition-colors">
      <canvas
        ref={canvasRef}
        className="rounded border border-border w-[72px] h-12 bg-background/50 flex-shrink-0"
        style={{
          imageRendering: 'pixelated',
          opacity: layer.visible ? 1 : 0.3
        }}
      />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <h3 className="font-mono text-xs font-bold text-foreground truncate">
            z {depthRange}
          </h3>
          {layer.size > 1 && (
            <Badge variant="outline" className="text-xs font-mono px-1 py-0 h-4 leading-none">
              ×{layer.size}
            </Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground font-mono truncate">
          {layer.voxels.length} voxels
        </div>
      </div>

      <Switch
        checked={layer.visible}
        onCheckedChange={() => { onToggleVisibility(layer.depth) }}
        className="data-[state=checked]:bg-primary flex-shrink-0"
      />
    </div>
  )
}

export function LayerPreview({ layers, onToggleVisibility }: LayerPreviewProps) {
  const visibleCount = layers.filter(l => l.visible).length
  const totalCount = layers.length

  return (
    <Card className="bg-card/90 backdrop-blur-sm w-72 flex flex-col max-h-[calc(100vh-48px)] gap-0 py-0 overflow-hidden">
      <div className="px-3 py-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Stack className="text-primary flex-shrink-0" size={18} />
          <h2 className="font-bold text-base">Layers</h2>
        </div>
        <Badge variant="secondary" className="font-mono text-xs flex-shrink-0">
          {visibleCount}/{totalCount}
        </Badge>
      </div>

      <Separator />

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-2 space-y-1">
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
    </Card>
  )
}
