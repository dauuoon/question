"use server";

import { redirect } from "next/navigation";
import { loginIdentifierToAuthEmail } from "@/lib/auth/identity";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/errors/report";

export async function signIn(formData: FormData) {
  const identifier = formData.get("identifier");
  const password = formData.get("password");

  if (
    typeof identifier !== "string" ||
    typeof password !== "string" ||
    identifier.trim().length === 0 ||
    password.length === 0
  ) {
    redirect("/login?error=AUTH-001");
  }

  let email: string;
  try {
    email = loginIdentifierToAuthEmail(identifier);
  } catch {
    redirect("/login?error=AUTH-001");
  }

  const supabase = await createSupabaseServerClient({ allowCookieWrites: true });
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError) {
    await reportError("AUTH-001", "login.credentials", {}, signInError.code);
    redirect("/login?error=AUTH-001");
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError) {
    await reportError("AUTH-004", "login.verify", {}, userError.code);
    redirect("/login?error=AUTH-004");
  }
  if (!user) {
    redirect("/login?error=AUTH-001");
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role, status")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    await reportError("AUTH-004", "login.profile", {}, profileError.code);
    redirect("/login?error=AUTH-004");
  }

  if (!profile || profile.status !== "active") {
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) {
      await reportError("AUTH-004", "login.clear_denied_session", {}, signOutError.code);
      redirect("/login?error=AUTH-004");
    }
    redirect("/login?error=AUTH-002");
  }

  redirect(profile.role === "admin" ? "/admin" : "/");
}

export async function signOut() {
  const supabase = await createSupabaseServerClient({ allowCookieWrites: true });
  const { error } = await supabase.auth.signOut();
  if (error) {
    await reportError("AUTH-004", "logout", {}, error.code);
    redirect("/login?error=AUTH-004");
  }
  redirect("/login");
}
