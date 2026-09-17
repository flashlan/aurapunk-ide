import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowClockwiseIcon,
  CrosshairIcon,
  MagnifyingGlassIcon,
  MinusIcon,
  PlusIcon,
  XIcon,
} from '@phosphor-icons/react';
import { cn } from '@/shared/lib/utils';
import {
  fetchMemoryGraph,
  type MemoryGraphEdge,
  type MemoryGraphNode,
  type MemoryGraphOverview,
} from './UsageSettingsSection';
import {
  computeGraphLayout,
  nodeMatchesQuery,
  typeColorIndex,
} from './memoryGraphLayout';

/**
 * Graphify add-on: interactive renderer for the mem0 knowledge graph.
 *
 * Data comes from the bounded server-side projection
 * (`POST /api/usage/memory-graph`) — the same nodes/edges shape Graphify
 * writes to `graph.json` — rendered here as a force-directed map with
 * search, zoom/pan, node dragging and click-to-inspect details.
 */

const WORLD_WIDTH = 960;
const WORLD_HEIGHT = 440;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 4;
const CLICK_DRAG_THRESHOLD_PX = 4;

/** Graphify-style community palette, one slot per node type. */
const TYPE_PALETTE = [
  '#60a5fa',
  '#34d399',
  '#fbbf24',
  '#f87171',
  '#a78bfa',
  '#22d3ee',
  '#fb7185',
  '#a3e635',
] as const;

interface ViewState {
  x: number;
  y: number;
  k: number;
}

const INITIAL_VIEW: ViewState = { x: 0, y: 0, k: 1 };

interface DragState {
  mode: 'pan' | 'node';
  nodeId?: string;
  startClientX: number;
  startClientY: number;
  originView: ViewState;
  originOffset: { x: number; y: number };
  moved: boolean;
}

function truncateLabel(value: string, max = 26): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function nodeRadius(node: MemoryGraphNode, jitter: number): number {
  return 5 + Math.min(8, node.degree * 1.25) + jitter * 2;
}

function GraphStatsLine({ graph }: { graph: MemoryGraphOverview }) {
  const { t } = useTranslation('settings');
  return (
    <p className="text-xs text-low">
      {t('settings.addons.viewer.stats', {
        nodes: graph.nodes.length,
        edges: graph.edges.length,
      })}
      {graph.truncated && (
        <span className="ml-2 text-amber-500">
          {t(
            'settings.addons.viewer.truncated',
            'Bounded projection — showing a subset of the full graph.'
          )}
        </span>
      )}
    </p>
  );
}

function GraphLegend({
  counts,
  activeType,
  onSelect,
}: {
  counts: { type: string; count: number }[];
  activeType: string | null;
  onSelect: (type: string | null) => void;
}) {
  const { t } = useTranslation('settings');
  if (counts.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-low">
        {t('settings.addons.viewer.legend', 'Node types')}
      </span>
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={cn(
          'rounded-full border px-2 py-0.5 text-xs transition-colors',
          activeType === null
            ? 'border-brand bg-brand/10 text-brand'
            : 'border-border text-low hover:text-normal'
        )}
      >
        {t('settings.addons.viewer.allTypes', 'All')}
      </button>
      {counts.map(({ type, count }) => {
        const color = TYPE_PALETTE[typeColorIndex(type, TYPE_PALETTE.length)];
        const isActive = activeType === type;
        return (
          <button
            key={type}
            type="button"
            onClick={() => onSelect(isActive ? null : type)}
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors',
              isActive
                ? 'border-brand bg-brand/10 text-brand'
                : 'border-border text-low hover:text-normal'
            )}
          >
            <span
              className="inline-block size-2 rounded-full"
              style={{ backgroundColor: color }}
            />
            {truncateLabel(type || 'unknown', 18)} · {count}
          </button>
        );
      })}
    </div>
  );
}

function NodeDetails({
  node,
  edges,
  onSelectNode,
  onClose,
}: {
  node: MemoryGraphNode;
  edges: MemoryGraphEdge[];
  onSelectNode: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings');
  const color = TYPE_PALETTE[typeColorIndex(node.type, TYPE_PALETTE.length)];
  const outgoing = edges.filter((edge) => edge.subject === node.id);
  const incoming = edges.filter((edge) => edge.object === node.id);

  const renderEdgeList = (
    list: MemoryGraphEdge[],
    other: (edge: MemoryGraphEdge) => string
  ) => (
    <ul className="space-y-1">
      {list.map((edge, index) => (
        <li
          key={`${edge.subject}:${edge.predicate}:${edge.object}:${index}`}
          className="flex items-center gap-1.5 text-xs"
        >
          <span className="rounded-sm bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-low">
            {edge.predicate}
          </span>
          <button
            type="button"
            onClick={() => onSelectNode(other(edge))}
            className="truncate text-left text-brand hover:underline"
          >
            {other(edge)}
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="rounded-sm border border-border bg-secondary/30 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
          />
          <h4 className="truncate text-sm font-medium text-high">{node.id}</h4>
        </div>
        <button
          type="button"
          onClick={onClose}
          title={t(
            'settings.addons.viewer.details.close',
            'Clear selection'
          )}
          className="rounded-sm p-0.5 text-low hover:text-normal"
        >
          <XIcon className="size-3.5" weight="bold" />
        </button>
      </div>
      <dl className="mt-2 space-y-1 text-xs">
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-low">
            {t('settings.addons.viewer.details.type', 'Type')}
          </dt>
          <dd className="text-normal">{node.type || 'unknown'}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-low">
            {t('settings.addons.viewer.details.degree', 'Degree')}
          </dt>
          <dd className="text-normal">{node.degree}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-low">
            {t('settings.addons.viewer.details.description', 'Description')}
          </dt>
          <dd className="text-normal">
            {node.description ||
              t(
                'settings.addons.viewer.details.noDescription',
                'No description recorded.'
              )}
          </dd>
        </div>
      </dl>
      {outgoing.length > 0 && (
        <div className="mt-2">
          <p className="mb-1 text-2xs font-semibold uppercase tracking-[0.08em] text-low">
            {t('settings.addons.viewer.details.outgoing', 'Outgoing')}
          </p>
          {renderEdgeList(outgoing, (edge) => edge.object)}
        </div>
      )}
      {incoming.length > 0 && (
        <div className="mt-2">
          <p className="mb-1 text-2xs font-semibold uppercase tracking-[0.08em] text-low">
            {t('settings.addons.viewer.details.incoming', 'Incoming')}
          </p>
          {renderEdgeList(incoming, (edge) => edge.subject)}
        </div>
      )}
    </div>
  );
}

export function MemoryGraphViewer() {
  const { t } = useTranslation('settings');
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const [userId, setUserId] = useState('default');
  const [graph, setGraph] = useState<MemoryGraphOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeType, setActiveType] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<ViewState>(INITIAL_VIEW);
  const [offsets, setOffsets] = useState<Record<string, { x: number; y: number }>>(
    {}
  );

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchMemoryGraph(id.trim() || 'default');
      setGraph(next);
      setSelectedId(null);
      setActiveType(null);
      setOffsets({});
      setView(INITIAL_VIEW);
    } catch (e) {
      setGraph(null);
      setError(e instanceof Error ? e.message : 'Failed to load memory graph');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load('default');
  }, [load]);

  const layout = useMemo(() => {
    if (!graph) return new Map();
    return computeGraphLayout(graph.nodes, graph.edges, WORLD_WIDTH, WORLD_HEIGHT);
  }, [graph]);

  const nodeById = useMemo(() => {
    if (!graph) return new Map<string, MemoryGraphNode>();
    return new Map(graph.nodes.map((node) => [node.id, node]));
  }, [graph]);

  const typeCounts = useMemo(() => {
    if (!graph) return [];
    const counts = new Map<string, number>();
    for (const node of graph.nodes) {
      const type = node.type || 'unknown';
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);
  }, [graph]);

  const matchCount = useMemo(() => {
    if (!graph || !query.trim()) return 0;
    return graph.nodes.filter((node) => nodeMatchesQuery(node, query)).length;
  }, [graph, query]);

  const selectedNode = selectedId ? (nodeById.get(selectedId) ?? null) : null;

  const positionOf = useCallback(
    (id: string) => {
      const base = layout.get(id);
      if (!base) return null;
      const offset = offsets[id];
      return {
        x: base.x + (offset?.x ?? 0),
        y: base.y + (offset?.y ?? 0),
        z: base.z,
      };
    },
    [layout, offsets]
  );

  /** Screen-pixel scale + letterbox offset of the meet-fitted viewBox. */
  const screenMetrics = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const scale = Math.min(
      rect.width / WORLD_WIDTH,
      rect.height / WORLD_HEIGHT
    );
    return {
      scale,
      offsetX: (rect.width - WORLD_WIDTH * scale) / 2,
      offsetY: (rect.height - WORLD_HEIGHT * scale) / 2,
    };
  }, []);

  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const svg = svgRef.current;
      const metrics = screenMetrics();
      if (!svg || !metrics) return;
      const rect = svg.getBoundingClientRect();
      const anchorX =
        (clientX - rect.left - metrics.offsetX) / metrics.scale;
      const anchorY =
        (clientY - rect.top - metrics.offsetY) / metrics.scale;
      setView((prev) => {
        const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev.k * factor));
        if (k === prev.k) return prev;
        const ratio = k / prev.k;
        return {
          k,
          x: anchorX - (anchorX - prev.x) * ratio,
          y: anchorY - (anchorY - prev.y) * ratio,
        };
      });
    },
    [screenMetrics]
  );

  // Native wheel listener (passive: false) so pinch/scroll zooms the graph
  // instead of scrolling the settings panel.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0015));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const beginDrag = (
    mode: DragState['mode'],
    nodeId: string | undefined,
    e: ReactPointerEvent
  ) => {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const existing = nodeId ? offsets[nodeId] : undefined;
    dragRef.current = {
      mode,
      nodeId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      originView: view,
      originOffset: existing ? { ...existing } : { x: 0, y: 0 },
      moved: false,
    };
  };

  const handlePointerMove = (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    const metrics = screenMetrics();
    if (!drag || !metrics) return;
    const dxPx = e.clientX - drag.startClientX;
    const dyPx = e.clientY - drag.startClientY;
    if (
      !drag.moved &&
      Math.hypot(dxPx, dyPx) < CLICK_DRAG_THRESHOLD_PX
    ) {
      return;
    }
    drag.moved = true;
    if (drag.mode === 'pan') {
      const dx = dxPx / metrics.scale;
      const dy = dyPx / metrics.scale;
      setView({
        k: drag.originView.k,
        x: drag.originView.x + dx,
        y: drag.originView.y + dy,
      });
    } else if (drag.nodeId) {
      const dx = dxPx / metrics.scale / drag.originView.k;
      const dy = dyPx / metrics.scale / drag.originView.k;
      const nodeId = drag.nodeId;
      setOffsets((prev) => ({
        ...prev,
        [nodeId]: {
          x: drag.originOffset.x + dx,
          y: drag.originOffset.y + dy,
        },
      }));
    }
  };

  const endDrag = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.moved) return;
    if (drag.mode === 'node' && drag.nodeId) {
      setSelectedId(drag.nodeId);
    } else if (drag.mode === 'pan') {
      setSelectedId(null);
    }
  };

  const isDimmed = (node: MemoryGraphNode): boolean => {
    if (activeType && (node.type || 'unknown') !== activeType) return true;
    if (query.trim() && !nodeMatchesQuery(node, query)) return true;
    return false;
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1">
          <label
            htmlFor="graphify-user-id"
            className="text-xs font-medium text-normal"
          >
            {t('settings.addons.viewer.userId', 'Memory user')}
          </label>
          <input
            id="graphify-user-id"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void load(userId);
            }}
            placeholder="default"
            className="w-full rounded-sm border border-border bg-secondary/40 px-2 py-1.5 text-sm text-high placeholder:text-low/60 focus:border-brand focus:outline-none"
          />
          <p className="text-2xs text-low">
            {t(
              'settings.addons.viewer.userIdHint',
              'mem0 user_id whose graph is rendered (one per repository).'
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(userId)}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-sm border border-border px-3 py-1.5 text-sm text-normal transition-colors hover:border-brand hover:text-brand disabled:opacity-50"
        >
          <ArrowClockwiseIcon
            className={cn('size-icon-xs', loading && 'animate-spin')}
            weight="bold"
          />
          {t('settings.addons.viewer.reload', 'Reload graph')}
        </button>
      </div>

      {error && (
        <p className="rounded-sm border border-error/40 bg-error/10 px-3 py-2 text-sm text-error">
          {error}
        </p>
      )}

      {loading && !graph && (
        <p className="py-8 text-center text-sm text-low">
          {t('settings.addons.viewer.loading', 'Loading memory graph…')}
        </p>
      )}

      {graph && (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <MagnifyingGlassIcon className="pointer-events-none absolute left-2 top-1/2 size-icon-xs -translate-y-1/2 text-low" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t(
                  'settings.addons.viewer.search',
                  'Search nodes…'
                )}
                aria-label={t(
                  'settings.addons.viewer.search',
                  'Search nodes…'
                )}
                className="w-full rounded-sm border border-border bg-secondary/40 py-1.5 pl-8 pr-2 text-sm text-high placeholder:text-low/60 focus:border-brand focus:outline-none"
              />
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                title={t('settings.addons.viewer.zoomIn', 'Zoom in')}
                onClick={() => {
                  const rect = svgRef.current?.getBoundingClientRect();
                  if (rect)
                    zoomAt(
                      rect.left + rect.width / 2,
                      rect.top + rect.height / 2,
                      1.25
                    );
                }}
                className="rounded-sm border border-border p-1.5 text-normal hover:border-brand hover:text-brand"
              >
                <PlusIcon className="size-icon-xs" weight="bold" />
              </button>
              <button
                type="button"
                title={t('settings.addons.viewer.zoomOut', 'Zoom out')}
                onClick={() => {
                  const rect = svgRef.current?.getBoundingClientRect();
                  if (rect)
                    zoomAt(
                      rect.left + rect.width / 2,
                      rect.top + rect.height / 2,
                      0.8
                    );
                }}
                className="rounded-sm border border-border p-1.5 text-normal hover:border-brand hover:text-brand"
              >
                <MinusIcon className="size-icon-xs" weight="bold" />
              </button>
              <button
                type="button"
                title={t('settings.addons.viewer.zoomReset', 'Reset view')}
                onClick={() => setView(INITIAL_VIEW)}
                className="rounded-sm border border-border p-1.5 text-normal hover:border-brand hover:text-brand"
              >
                <CrosshairIcon className="size-icon-xs" weight="bold" />
              </button>
            </div>
          </div>

          <GraphStatsLine graph={graph} />
          {query.trim() && (
            <p className="text-xs text-low">
              {t('settings.addons.viewer.matches', {
                count: matchCount,
                defaultValue: '{{count}} matching nodes',
              })}
            </p>
          )}
          <GraphLegend
            counts={typeCounts}
            activeType={activeType}
            onSelect={setActiveType}
          />

          {graph.nodes.length === 0 ? (
            <p className="rounded-sm border border-border bg-secondary/25 px-3 py-8 text-center text-sm text-low">
              {t(
                'settings.addons.viewer.empty',
                'No graph nodes for this user yet. Save memories first, then reload.'
              )}
            </p>
          ) : (
            <svg
              ref={svgRef}
              viewBox={`0 0 ${WORLD_WIDTH} ${WORLD_HEIGHT}`}
              onPointerDown={(e) => beginDrag('pan', undefined, e)}
              onPointerMove={handlePointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              role="img"
              aria-label={t(
                'settings.addons.viewer.graphLabel',
                'Interactive mem0 knowledge graph'
              )}
              className="h-[380px] w-full cursor-grab touch-none select-none rounded-sm border border-border bg-secondary/25 active:cursor-grabbing"
            >
              <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                {graph.edges.map((edge, index) => {
                  const source = positionOf(edge.subject);
                  const target = positionOf(edge.object);
                  if (!source || !target) return null;
                  return (
                    <line
                      key={`${edge.subject}:${edge.predicate}:${edge.object}:${index}`}
                      x1={source.x}
                      y1={source.y}
                      x2={target.x}
                      y2={target.y}
                      stroke="currentColor"
                      strokeOpacity="0.22"
                      strokeWidth={1 / view.k}
                      className="text-brand"
                    >
                      <title>{`${edge.subject} —${edge.predicate}→ ${edge.object}`}</title>
                    </line>
                  );
                })}
                {graph.nodes.map((node) => {
                  const point = positionOf(node.id);
                  if (!point) return null;
                  const color =
                    TYPE_PALETTE[typeColorIndex(node.type, TYPE_PALETTE.length)];
                  const radius = nodeRadius(node, point.z);
                  const dimmed = isDimmed(node);
                  const selected = selectedId === node.id;
                  return (
                    <g
                      key={node.id}
                      transform={`translate(${point.x} ${point.y})`}
                      opacity={dimmed ? 0.15 : 1}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        beginDrag('node', node.id, e);
                      }}
                      className="cursor-pointer"
                    >
                      <title>{`${node.id}${node.description ? ` — ${node.description}` : ''}`}</title>
                      <circle
                        r={radius + 7}
                        fill={color}
                        opacity="0.07"
                      />
                      <circle
                        r={radius}
                        fill={color}
                        fillOpacity="0.35"
                        stroke={color}
                        strokeOpacity="0.9"
                        strokeWidth={selected ? 2.5 / view.k : 1.25 / view.k}
                      />
                      <text
                        x={radius + 6}
                        y={4 / view.k}
                        fontSize={11 / view.k}
                        className="fill-high"
                        opacity={dimmed ? 0.5 : 0.85}
                      >
                        {truncateLabel(node.id)}
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>
          )}

          {selectedNode && (
            <NodeDetails
              node={selectedNode}
              edges={graph.edges}
              onSelectNode={setSelectedId}
              onClose={() => setSelectedId(null)}
            />
          )}
        </>
      )}
    </div>
  );
}
