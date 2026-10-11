import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/errors/report";
import { isInvalidAuthSession } from "@/lib/auth/session-error";
import { cache } from "react";

export type UserRole = "participant" | "admin";

const verifiedAccount = cache(async () => {
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

  return { supabase, user, profile };
});

export async function requireRole(expectedRole: UserRole) {
  const { supabase, user, profile } = await verifiedAccount();
  if (profile.role !== expectedRole) {
    redirect(profile.role === "admin" ? "/admin" : "/");
  }

  return { supabase, user };
}
