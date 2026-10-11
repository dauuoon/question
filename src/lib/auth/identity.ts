const participantCodePattern = /^[PT]\d{2,}$/i;
const internalAuthDomain = "participants.whybox.invalid";

export function participantCodeToAuthEmail(participantCode: string): string {
  const normalizedCode = participantCode.trim().toUpperCase();
  if (!participantCodePattern.test(normalizedCode)) {
    throw new Error("Account code must look like P01 or T01.");
  }

  return `${normalizedCode.toLowerCase()}@${internalAuthDomain}`;
}

export function loginIdentifierToAuthEmail(identifier: string): string {
  const normalizedIdentifier = identifier.trim();
  if (normalizedIdentifier.includes("@")) {
    return normalizedIdentifier;
  }

  return participantCodeToAuthEmail(normalizedIdentifier);
}
