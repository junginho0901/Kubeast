import type { LucideIcon } from 'lucide-react'
import {
  Archive, ArrowUpWideNarrow, BadgeCheck, Box, Boxes, CalendarClock, ChartPie, CirclePlay, Container, Copy, Cpu,
  Database, DoorOpen, FileText, HardDrive, HardDriveDownload, KeyRound, KeySquare, Link, Lock, LockKeyhole, LogIn,
  MoveHorizontal, MoveVertical, Network, Package, Paperclip, Plug, PlugZap, Puzzle, Radio, Rocket, Route, Ruler,
  Server, ServerCog, Shapes, ShieldAlert, ShieldHalf, Slice, Tag, Tags, Ticket, TicketPlus, Timer, UserCog,
  UserPlus, UsersRound, Webhook,
} from 'lucide-react'

// One icon per Kubernetes kind, shared by the sidebar and the resource drawer header so the same kind always
// has the same picture (and no two kinds share one).
export const KIND_ICONS: Record<string, LucideIcon> = {
  Namespace: Boxes, Node: Server, PriorityClass: ArrowUpWideNarrow, RuntimeClass: Container, Lease: Timer,
  ResourceQuota: ChartPie, LimitRange: Ruler, MutatingWebhookConfiguration: Webhook, ValidatingWebhookConfiguration: BadgeCheck,
  Pod: Box, Deployment: Rocket, StatefulSet: Database, DaemonSet: ServerCog, ReplicaSet: Copy, Job: CirclePlay,
  CronJob: CalendarClock, HorizontalPodAutoscaler: MoveHorizontal, VerticalPodAutoscaler: MoveVertical,
  PodDisruptionBudget: ShieldAlert,
  PersistentVolumeClaim: HardDriveDownload, PersistentVolume: HardDrive, StorageClass: Archive, VolumeAttachment: Paperclip,
  Service: Network, Endpoints: Plug, EndpointSlice: PlugZap, Ingress: LogIn, IngressClass: Tag, NetworkPolicy: ShieldHalf,
  Gateway: DoorOpen, GatewayClass: Tags, HTTPRoute: Route, GRPCRoute: Radio, ReferenceGrant: Link, BackendTLSPolicy: Lock,
  DeviceClass: Cpu, ResourceClaim: Ticket, ResourceClaimTemplate: TicketPlus, ResourceSlice: Slice,
  ServiceAccount: UserCog, Role: KeyRound, ClusterRole: KeySquare, RoleBinding: UserPlus, ClusterRoleBinding: UsersRound,
  ConfigMap: FileText, Secret: LockKeyhole,
  CustomResourceDefinition: Puzzle, CustomResourceInstance: Shapes, HelmRelease: Package,
}

export function kindIconComponent(kind: string): LucideIcon {
  return KIND_ICONS[kind] ?? FileText
}
