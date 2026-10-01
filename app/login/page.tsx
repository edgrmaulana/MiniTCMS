import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import Aurora from "./aurora";
import LoginForm from "./login-form";

export const metadata: Metadata = {
  title: "Sign in / minitcms",
  description: "Sign in to the minitcms test console.",
};

export default async function LoginPage() {
  if (await currentUser()) redirect("/");

  return (
    <main className="grid min-h-dvh grid-cols-1 lg:grid-cols-[1.15fr_1fr]">
      <section className="hero relative isolate hidden overflow-hidden lg:block">
        <Aurora />
        <div className="hero-copy relative z-10 flex h-full flex-col justify-between p-12">
          <p className="wordmark">minitcms / test console</p>
          <div className="max-w-md">
            <h1 className="display text-5xl leading-[1.05]">
              Cases, runs, results — and the door out of TestRail.
            </h1>
            <p className="mt-5 text-sm leading-relaxed text-muted">
              Move the cursor to sway the veil.
            </p>
          </div>
        </div>
      </section>

      <section className="panel flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm">
          <p className="wordmark lg:hidden">minitcms / test console</p>
          <h2 className="display mt-8 text-3xl lg:mt-0">Sign in</h2>
          <p className="mt-2 text-sm text-muted">
            Use the email address your account was created with.
          </p>
          <div className="mt-10">
            <LoginForm />
          </div>
          <p className="mt-10 text-xs leading-relaxed text-muted">
            No self-service signup. An admin creates accounts, or they arrive with the
            TestRail import.
          </p>
        </div>
      </section>
    </main>
  );
}
