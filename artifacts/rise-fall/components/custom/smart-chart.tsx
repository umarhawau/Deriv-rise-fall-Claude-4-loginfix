'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTheme } from 'next-themes';
import {
  ChartMode,
  ChartTitle,
  DrawTools,
  Share,
  setSmartChartsPublicPath,
  SmartChart,
  StudyLegend,
  ToolbarWidget,
  Views,
} from '@deriv-com/smartcharts-champion';
import type { UseSmartChartsApiReturn } from '@/hooks/use-smartcharts-api';
import type { SmartChartChartData } from '@/hooks/use-smartchart-chart-data';
import type { ContractMarker } from '@/lib/chart-markers';
import { SMART_CHART_DRAWING_TOOL_POSITION } from '@/lib/smartchart-constants';

// In preview deployments the app is served under a basePath, so
// SmartCharts must load its lazy assets from that same prefix.
const smartChartsPublicPath =
  process.env.NEXT_PUBLIC_BASE_PATH ? `${process.env.NEXT_PUBLIC_BASE_PATH}/` : '/';
setSmartChartsPublicPath(smartChartsPublicPath);

/** Configuration for a single barrier rendered on the chart. */
export interface ChartBarrier {
  /** Shade type: 'ABOVE', 'BELOW', 'BETWEEN', 'OUTSIDE', 'NONE_SINGLE', 'NONE_DOUBLE'. */
  shade?: string;
  /** Barrier line color. */
  color?: string;
  /** Shade fill color (CSS variable on the shade div). */
  shadeColor?: string;
  /** Text color on the price label. */
  foregroundColor?: string;
  /** High barrier price value (absolute). */
  high?: number | string;
  /** Low barrier price value (absolute). */
  low?: number | string;
  /** Whether barriers are relative to the current spot price. */
  relative?: boolean;
  /** Whether the barrier can be dragged by the user. */
  draggable?: boolean;
  /** Hide the horizontal barrier line. */
  hideBarrierLine?: boolean;
  /** Hide the offscreen barrier indicator arrow. */
  hideOffscreenBarrier?: boolean;
  /** Hide the offscreen barrier line. */
  hideOffscreenLine?: boolean;
  /** Hide the price label on the barrier. */
  hidePriceLabel?: boolean;
}

export interface SmartChartWrapperProps {
  /** Unique chart instance id (e.g. `"rise-fall-chart"`, `"accumulator-chart"`). */
  chartId: string;
  /** Stable key when the underlying symbol changes. */
  symbolKey: string;
  symbol: string | undefined;
  isConnectionOpened: boolean;
  isMobile: boolean;
  chartData: SmartChartChartData | undefined;
  requestAPI: UseSmartChartsApiReturn['requestAPI'];
  getQuotes: UseSmartChartsApiReturn['getQuotes'];
  subscribeQuotes: UseSmartChartsApiReturn['subscribeQuotes'];
  unsubscribeQuotes: UseSmartChartsApiReturn['unsubscribeQuotes'];
  /** Called when the user selects a symbol from the built-in ChartTitle market browser. */
  onSymbolChange?: (symbol: string) => void;
  /** Whether SmartCharts should expect a live subscription feed. Defaults to true. */
  isLive?: boolean;
  /** Unix epoch (seconds) to freeze the chart at for preview mode. */
  endEpoch?: number;
  /** Default granularity (0 = ticks, 60 = 1m candles, etc.). Defaults to 0. */
  defaultGranularity?: number;
  /** Barriers to display on the chart. */
  barriers?: ChartBarrier[];
  /** Contract markers to display entry/exit spots on the chart when trades are placed. */
  contractsArray?: ContractMarker[];
}

export function SmartChartWrapper({
  chartId,
  symbolKey,
  symbol,
  isConnectionOpened,
  isMobile,
  chartData,
  requestAPI,
  getQuotes,
  subscribeQuotes,
  unsubscribeQuotes,
  onSymbolChange,
  isLive = true,
  endEpoch,
  defaultGranularity = 0,
  barriers,
  contractsArray,
}: SmartChartWrapperProps) {
  const [chartType, setChartType] = useState<string | undefined>('line');
  const [granularity, setGranularity] = useState(defaultGranularity);

  const { resolvedTheme } = useTheme();
  const chartTheme =
    (resolvedTheme ?? (document.documentElement.classList.contains('dark') ? 'dark' : 'light')) === 'dark'
      ? 'dark'
      : 'light';

  const chartSettings = useMemo(
    () => ({
      language: 'en' as const,
      isHighestLowestMarkerEnabled: false,
      theme: chartTheme,
    }),
    [chartTheme]
  );

  const toolbarWidget = useCallback(
    () => (
      <ToolbarWidget>
        <ChartMode onChartType={setChartType} onGranularity={setGranularity} />
        {!isMobile && <StudyLegend />}
        {!isMobile && <Views onChartType={setChartType} onGranularity={setGranularity} />}
        <DrawTools />
        {!isMobile && <Share />}
      </ToolbarWidget>
    ),
    [isMobile]
  );

  const topWidgets = useCallback(
    () => <ChartTitle onChange={onSymbolChange} />,
    [onSymbolChange]
  );

  return (
    <div className="relative h-full min-h-0 w-full overflow-clip rounded-md border border-border/50 dark:border-white/[0.08] bg-muted/30">
      <SmartChart
        key={symbolKey}
        chartControlsWidgets={null}
        chartData={chartData}
        chartStatusListener={() => {}}
        chartType={chartType}
        clearChart={false}
        drawingToolFloatingMenuPosition={
          isMobile ? SMART_CHART_DRAWING_TOOL_POSITION.mobile : SMART_CHART_DRAWING_TOOL_POSITION.desktop
        }
        enabledChartFooter={false}
        enabledNavigationWidget={!isMobile}
        requestAPI={requestAPI}
        getQuotes={getQuotes}
        granularity={granularity}
        id={chartId}
        isConnectionOpened={isConnectionOpened}
        isLive={isLive}
        isMobile={isMobile}
        isVerticalScrollEnabled={false}
        {...(endEpoch !== undefined && { endEpoch })}
        maxTick={isMobile ? (granularity === 0 ? 8 : 24) : undefined}
        onSettingsChange={() => {}}
        settings={chartSettings}
        stateChangeListener={() => {}}
        subscribeQuotes={subscribeQuotes}
        symbol={symbol}
        toolbarWidget={toolbarWidget}
        topWidgets={topWidgets}
        unsubscribeQuotes={unsubscribeQuotes}
        {...(barriers && barriers.length > 0 && { barriers })}
        contracts_array={contractsArray ?? []}
      />
    </div>
  );
}
