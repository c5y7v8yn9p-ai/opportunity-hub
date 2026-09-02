// Seeker — Supabase connection config.
//
// These two values come from your Supabase project dashboard:
// Project Settings -> API -> "Project URL" and "anon public" key.
//
// The anon key is DESIGNED to be public (it ships in every Supabase
// browser app) — access control is enforced by the Row Level Security
// policies in supabase-schema.sql, not by hiding this key. Never put your
// "service_role" key here or anywhere in docs/ — that one bypasses RLS
// and must only live in the GitHub Actions secret used by scraper.py.
//
// See SETUP_GUIDE.md, stage 2, for how to create the project and run the
// schema file.

window.OPPORTUNITY_HUB_CONFIG = {
  SUPABASE_URL: "https://ztnuzhgdxcijnbtjorsu.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp0bnV6aGdkeGNpam5idGpvcnN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwMjY2MzksImV4cCI6MjEwMzYwMjYzOX0.bnmhdJ7ShrRP5cnrDnYL1xMZvGkqLHbI5_gb_7ZHj1o",
};
