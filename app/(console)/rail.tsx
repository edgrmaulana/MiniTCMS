"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { ListResult, ProjectRow } from "@/lib/format";
import { fetchJson } from "../fetch-json";
import { logout } from "../auth-actions";

// Only the screens that exist get a link; the rest arrive with their phase 5
// section rather than as a dead entry that 404s.
const DESTINATIONS = [
  { href: "/", label: "Dashboard" },
  { href: "/cases", label: "Cases" },
  { href: "/runs", label: "Runs" },
  { href: "/migrate", label: "Import" },
] as const;

/*
  The selected project lives in the query string and nowhere else, so a link
  pasted into a ticket opens the same screen the sender was looking at. Every
  rail link carries it; switching project drops the suite and section with it,
  because those ids belong to the project being left.
*/
export default function Rail({ email }: { email: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const projectId = searchParams.get("projectId");
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // ponytail: one page of projects in the switcher. A hundred-and-first
    // project needs a search box here, not a second fetch.
    fetchJson<ListResult<ProjectRow>>("/api/projects?limit=100")
      .then((result) => setProjects(result.rows))
      .catch((reason: Error) => setError(reason.message));
  }, []);

  /*
    A detail route carries a row id belonging to the project being left, so
    switching from /runs/12 goes to /runs, not to /runs/12 under a new project
    label. Same reasoning as dropping the suite and the section.
  */
  function switchProject(value: string) {
    const destination = listRouteFor(pathname);
    router.push(value ? `${destination}?projectId=${value}` : destination);
  }

  return (
    <nav className="rail" aria-label="Console">
      <Link href="/" className="wordmark">
        minitcms
      </Link>

      <div className="flex flex-col gap-2">
        <label htmlFor="project" className="label">
          Project
        </label>
        <select
          id="project"
          className="field-sm"
          value={projectId ?? ""}
          onChange={(event) => switchProject(event.target.value)}
        >
          <option value="">Select a project</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        {error ? (
          <p role="alert" className="text-xs text-alert">
            {error}
          </p>
        ) : null}
      </div>

      <ul className="flex flex-col gap-1">
        {DESTINATIONS.map((destination) => (
          <li key={destination.href}>
            <Link
              href={projectId ? `${destination.href}?projectId=${projectId}` : destination.href}
              aria-current={pathname === destination.href ? "page" : undefined}
              className="rail-link"
            >
              {destination.label}
            </Link>
          </li>
        ))}
      </ul>

      <div className="mt-auto flex flex-col gap-2 border-t border-line pt-4">
        <p className="truncate text-xs text-muted" title={email}>
          {email}
        </p>
        <form action={logout}>
          <button type="submit" className="chip w-full">
            Sign out
          </button>
        </form>
      </div>
    </nav>
  );
}

function listRouteFor(pathname: string): string {
  const [, section] = pathname.split("/");
  return section ? `/${section}` : "/";
}
