'use client';

import { useSmartChartsApi } from '@/hooks/use-smartcharts-api';
import { useSmartChartChartData } from '@/hooks/use-smartchart-chart-data';
import { useRiseFallTrading } from '../hooks/use-rise-fall-trading';
import { useAutotrade } from '../hooks/use-autotrade';
import { useBalance } from '../hooks/use-balance';
import { useDerivWSContext } from '@/components/custom/deriv-ws-provider';
import { useLogoSrc } from '@/components/custom/logo-src-provider';
import { RiseFallView } from '../components/rise-fall-view';

export default function RiseFallPage() {
  const logoSrc = useLogoSrc();
  const { ws, isConnected, isExhausted, auth } = useDerivWSContext();
  const { authState, accounts, activeAccount, login, signUp, logout, switchAccount } = auth;

  // Keep the header balance in sync with live WS balance events.
  // Also captures the account currency live so hooks use the real currency
  // instead of a hardcoded 'USD' fallback.
  const { currency } = useBalance(ws, isConnected, auth.activeAccountId, auth.updateAccountBalance);

  const trading = useRiseFallTrading({ ws, isConnected, isExhausted, isAuthenticated: !!auth.wsUrl, onAuthWSFailed: logout, currency: currency ?? 'USD' });

  const { chartData } = useSmartChartChartData(trading.ws, trading.isConnected, trading.symbols);
  const { requestAPI, getQuotes, subscribeQuotes, unsubscribeQuotes } = useSmartChartsApi(trading.ws);
  const autotrade = useAutotrade(
    trading.ws,
    trading.isConnected,
    trading.activeSymbol,
    trading.durationOptions,
    trading.openPositions,
    trading.currentTick?.quote ?? null,
    currency ?? 'USD',
    activeAccount?.account_id ?? 'anonymous'
  );

  return (
    <RiseFallView
      authState={authState}
      accounts={accounts}
      activeAccount={activeAccount}
      onLogin={login}
      onSignUp={signUp}
      onLogout={logout}
      onSwitchAccount={switchAccount}
      logoSrc={logoSrc}
      ws={trading.ws}
      isConnected={trading.isConnected}
      isLoading={trading.isLoading}
      error={trading.error}
      activeSymbol={trading.activeSymbol}
      selectSymbol={trading.selectSymbol}
      direction={trading.direction}
      setDirection={trading.setDirection}
      allowEquals={trading.allowEquals}
      setAllowEquals={trading.setAllowEquals}
      stake={trading.stake}
      setStake={trading.setStake}
      duration={trading.duration}
      setDuration={trading.setDuration}
      durationOptions={trading.durationOptions}
      durationUnit={trading.durationUnit}
      setDurationUnit={trading.setDurationUnit}
      endDate={trading.endDate}
      setEndDate={trading.setEndDate}
      endTime={trading.endTime}
      setEndTime={trading.setEndTime}
      proposal={trading.proposal}
      buyContract={trading.buyContract}
      isBuying={trading.isBuying}
      buyResult={trading.buyResult}
      buyError={trading.buyError}
      clearBuyResult={trading.clearBuyResult}
      openPositions={trading.openPositions}
      sellContract={trading.sellContract}
      sellingId={trading.sellingId}
      autotrade={autotrade}
      chartData={chartData}
      requestAPI={requestAPI}
      getQuotes={getQuotes}
      subscribeQuotes={subscribeQuotes}
      unsubscribeQuotes={unsubscribeQuotes}
    />
  );
}
