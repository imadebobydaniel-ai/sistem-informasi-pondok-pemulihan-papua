// Local contract only. All privileged calls are injected by the test harness.
export const admissionSchema = `
  CREATE TABLE qr_admission (
    utc_day TEXT PRIMARY KEY,
    credits INTEGER NOT NULL
  ) WITHOUT ROWID
`;

export function createAdmissionGate(db, {dailyCredits = 32_000, cost = 32} = {}) {
  if (!Number.isSafeInteger(dailyCredits) || !Number.isSafeInteger(cost) ||
      cost <= 0 || dailyCredits < cost || dailyCredits > 32_000) {
    throw new TypeError('Invalid admission envelope');
  }

  const reserve = `
    INSERT INTO qr_admission(utc_day, credits) VALUES (?, ?)
    ON CONFLICT(utc_day) DO UPDATE SET credits = credits + excluded.credits
    WHERE credits <= ?
    RETURNING credits
  `;

  return async function admit(now, verifiedOperation) {
    let admitted;
    try {
      const day = new Date(now).toISOString().slice(0, 10);
      admitted = await db.prepare(reserve).bind(day, cost, dailyCredits - cost).first();
    } catch {
      return {status: 503};
    }
    if (!admitted) return {status: 429};
    try {
      return await verifiedOperation();
    } catch {
      return {status: 503};
    }
  };
}

export function createMockBoundVerifier({workloadAssertion, exchangeSts, consumeAppCheck}) {
  // The assertion supplier is a deployment dependency, never a request field.
  return Object.freeze({
    async consume(attestation) {
      try {
        const assertion = await workloadAssertion();
        if (typeof assertion !== 'string' || !assertion) return false;
        const response = await exchangeSts({subjectToken: assertion});
        if (response?.token_type !== 'Bearer' ||
            typeof response.access_token !== 'string' || !response.access_token ||
            !Number.isSafeInteger(response.expires_in) || response.expires_in <= 0) return false;
        const result = await consumeAppCheck({
          accessToken: response.access_token, appCheckToken: attestation
        });
        if (result?.status !== 200 || !result.body ||
            Object.getPrototypeOf(result.body) !== Object.prototype) return false;
        const keys = Object.keys(result.body);
        return keys.length === 0 ||
          (keys.length === 1 && result.body.alreadyConsumed === false);
      } catch {
        return false;
      }
    }
  });
}

