import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react'
import type { EdgeRoute } from './elkLayout'
import { pointOnBezier, roundedPath } from './traffic'

// A line along the route ELK laid out (right angles between the boxes, rounded corners), its count where ELK
// placed it. Without a route (a layout that failed), React Flow's curve with the count past the middle.
export function RoutedEdge(props: EdgeProps) {
  const route = (props.data as { route?: EdgeRoute } | undefined)?.route
  const { sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition } = props
  let path: string
  let label: { x: number; y: number }
  if (route && route.points.length >= 2) {
    path = roundedPath(route.points, 8)
    label = route.label ?? route.points[Math.floor(route.points.length / 2)]
  } else {
    path = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })[0]
    const [x, y] = pointOnBezier(0.65, { sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
    label = { x, y }
  }
  return (
    <BaseEdge
      id={props.id}
      path={path}
      style={props.style}
      markerStart={props.markerStart}
      markerEnd={props.markerEnd}
      interactionWidth={props.interactionWidth}
      label={props.label}
      labelX={label.x}
      labelY={label.y}
      labelStyle={props.labelStyle}
      labelShowBg={props.labelShowBg}
      labelBgStyle={props.labelBgStyle}
      labelBgPadding={props.labelBgPadding}
      labelBgBorderRadius={props.labelBgBorderRadius}
    />
  )
}
