import { useState } from "react";
import { About } from "./About";
import { AppFooter } from "./components/AppFooter";
import { AppHeader, type AppPage } from "./components/AppHeader";
import { useBenchmarkController } from "./hooks/useBenchmarkController";
import { RacePage } from "./pages/RacePage";
import { ResultsPage } from "./pages/ResultsPage";
import { ReviewPage } from "./pages/ReviewPage";
import { SetupPage } from "./pages/SetupPage";

export function App() {
  const [page, setPage] = useState<AppPage>("benchmark");
  const benchmark = useBenchmarkController();
  const engineReady = benchmark.socketState === "open";

  function showHome() {
    setPage("benchmark");
    benchmark.showSetup();
  }

  return (
    <div className="app-shell">
      <AppHeader
        page={page}
        phase={benchmark.phase}
        socketState={benchmark.socketState}
        onHome={showHome}
        onToggleAbout={() => setPage(page === "about" ? "benchmark" : "about")}
      />

      <main>
        {page === "about" ? (
          <About onBack={() => setPage("benchmark")} />
        ) : (
          <>
            {benchmark.phase === "setup" && (
              <SetupPage
                competitors={benchmark.competitors}
                providers={benchmark.runnableProviders}
                providersLoading={benchmark.providersLoading}
                providersError={benchmark.providersError}
                canReview={benchmark.canReview}
                engineReady={engineReady}
                onRetryProviders={() => void benchmark.loadProviders()}
                onSelectionChange={benchmark.updateSelection}
                onAddCompetitor={benchmark.addCompetitor}
                onRemoveCompetitor={benchmark.removeCompetitor}
                onContinue={benchmark.reviewRace}
              />
            )}
            {benchmark.phase === "review" && (
              <ReviewPage
                competitors={benchmark.competitors}
                providers={benchmark.providers}
                mode={benchmark.mode}
                preset={benchmark.preset}
                notice={benchmark.notice}
                canStart={benchmark.canStart}
                engineReady={engineReady}
                onEditModels={benchmark.showSetup}
                onModeChange={benchmark.setMode}
                onPresetChange={benchmark.setPreset}
                onCompetitorNameChange={benchmark.updateCompetitorName}
                onStart={benchmark.startRace}
              />
            )}
            {benchmark.phase === "running" && (
              <RacePage
                competitors={benchmark.competitors}
                lanes={benchmark.lanes}
                totalRuns={benchmark.totalRuns}
                completedRuns={benchmark.completedRuns}
                notice={benchmark.notice}
                onCancel={benchmark.cancelRace}
              />
            )}
            {benchmark.phase === "results" && (
              <ResultsPage
                competitors={benchmark.competitors}
                results={benchmark.results}
                summary={benchmark.summary}
                onEditGrid={benchmark.showSetup}
                onRaceAgain={benchmark.resetRace}
              />
            )}
          </>
        )}
      </main>

      <AppFooter />
    </div>
  );
}
