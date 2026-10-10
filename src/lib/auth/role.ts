import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/errors/report";
import { isInvalidAuthSession } from "@/lib/auth/session-error";

export type UserRole = "participant" | "admin";

export async function requireRole(expectedRole: UserRole) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError && isInvalidAuthSession(authError)) {
    if (authError.name === "AuthSessionMissingError") redirect("/login");
    await reportError("AUTH-005", "role.session_expired", {}, authError.code);
    redirect("/login?error=AUTH-005");
  }

  if (authError) {
    await reportError("AUTH-004", "role.verify", {}, authError.code);
    throw new Error("Unable to verify the current session.");
  }

  if (!user || authError) {
    redirect("/login");
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role, status")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    await reportError("AUTH-004", "role.profile", {}, profileError.code);
    throw new Error("Unable to verify account access.");
  }

  if (!profile || profile.status !== "active") {
    redirect("/login?error=AUTH-002");
  }

  if (profile.role !== expectedRole) {
    redirect(profile.role === "admin" ? "/admin" : "/");
  }

  return { supabase, user };
}
