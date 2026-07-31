'use client';

import { useActionState, useRef } from 'react';
import { loginAction } from './actions';


const initial = { error: null as string | null };

export function AdminLoginForm() {
  const [state, dispatch, isPending] = useActionState(loginAction, initial);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">

        {/* Logo / Brand */}
        <div className="text-center mb-8 space-y-2">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-violet-500/15 border border-violet-500/30 mb-2">
            <svg className="w-6 h-6 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.955 11.955 0 003 12c0 3.57 1.572 6.77 4.063 8.965M12 2.25c2.987 0 5.69 1.104 7.725 2.906L21 6m-9 15.75A11.955 11.955 0 0021 12c0-1.398-.24-2.74-.683-3.988" />
            </svg>
          </div>
          <h1 className="text-lg font-bold text-white tracking-tight">Quant Admin Terminal</h1>
          <p className="text-xs text-zinc-500">PulseEdge · Restricted Access</p>
        </div>

        {/* Card */}
        <form action={dispatch} className="rounded-2xl border border-zinc-800 bg-zinc-900/80 backdrop-blur-sm p-6 space-y-5 shadow-2xl shadow-black/40">

          <div className="space-y-1.5">
            <label htmlFor="token" className="block text-xs font-semibold text-zinc-400 uppercase tracking-widest">
              Admin Secret Token
            </label>
            <div className="relative">
              <input
                ref={inputRef}
                id="token"
                name="token"
                type="password"
                autoComplete="current-password"
                autoFocus
                required
                placeholder="Enter admin secret…"
                className="w-full bg-zinc-800/80 border border-zinc-700 rounded-lg px-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 transition-all"
              />
            </div>
          </div>

          {state.error && (
            <div className="flex items-start gap-2.5 rounded-lg bg-rose-500/10 border border-rose-500/25 px-3.5 py-3">
              <svg className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z" />
              </svg>
              <p className="text-xs text-rose-400 leading-relaxed">{state.error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={isPending}
            className="w-full bg-violet-600 hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold text-sm py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            {isPending ? (
              <>
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Verifying…
              </>
            ) : (
              'Access Dashboard'
            )}
          </button>

          <p className="text-center text-[10px] text-zinc-600 pt-1">
            Session is valid for 8 hours · Not for retail users
          </p>
        </form>
      </div>
    </div>
  );
}
