import { useEffect, useRef } from 'react'
import type { Layer } from '@/lib/renderer'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Layers } from 'lucide-react'

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
    const thumb = canvasRef.current
    const ctx = thumb?.getContext('2d')
    if (!thumb || !ctx) return
    ctx.clearRect(0, 0, thumb.width, thumb.height)
    const { width, height } = layer.canvas
    if (width === 0 || height === 0) return
    // Fit the (cropped) layer canvas into the thumbnail, centred.
    const fit = Math.min(thumb.width / width, thumb.height / height)
    const w = width * fit
    const h = height * fit
    ctx.drawImage(layer.canvas, (thumb.width - w) / 2, (thumb.height - h) / 2, w, h)
  }, [layer.canvas])

  const depthRange = layer.size === 1
    ? String(layer.depth)
    : `${String(layer.depth)}..${String(layer.depth + layer.size - 1)}`

  return (
    <div className="flex items-center gap-2 p-1.5 rounded-md bg-muted/30 hover:bg-muted/50 transition-colors">
      <canvas
        ref={canvasRef}
        width={144}
        height={96}
        className="rounded border border-border w-[72px] h-12 bg-background/50 flex-shrink-0"
        style={{ opacity: layer.visible ? 1 : 0.3 }}
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
  // Slices with nothing to draw (e.g. between the camera and the world) only add noise.
  const drawn = layers.filter(l => l.facesDrawn > 0)
  const emptyCount = layers.length - drawn.length
  const visibleCount = drawn.filter(l => l.visible).length

  return (
    <Card className="pointer-events-auto flex min-h-0 flex-col gap-0 overflow-hidden bg-card/80 py-0 backdrop-blur-md">
      <div className="px-3 py-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Layers className="text-primary flex-shrink-0" size={16} />
          <h2 className="text-sm font-semibold">Layers</h2>
        </div>
        <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          {emptyCount > 0 && <span>+{emptyCount} empty</span>}
          <Badge variant="secondary" className="font-mono text-xs flex-shrink-0">
            {visibleCount}/{drawn.length}
          </Badge>
        </div>
      </div>

      <Separator />

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-2 space-y-1">
          {drawn.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              Nothing in view
            </div>
          ) : (
            drawn.map(layer => (
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
