export default function SettingsPage() {
  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Settings</h1>
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <p className="text-gray-500 text-sm">
          Settings UI is coming in Phase 3. For now, edit{" "}
          <code className="bg-gray-100 px-1 rounded">src/config.ts</code> and{" "}
          <code className="bg-gray-100 px-1 rounded">.env</code> directly.
        </p>
        <p className="text-gray-400 text-xs mt-3">
          Planned: search keywords · salary threshold · ATS watchlist · outreach templates · AI providers · account details.
        </p>
      </div>
    </div>
  );
}
