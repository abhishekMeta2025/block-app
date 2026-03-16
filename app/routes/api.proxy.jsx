import { authenticate } from "../shopify.server";

/**
 * App Proxy route — called by storefront JS when the loyalty discount
 * checkbox is checked. Shopify forwards /apps/block-loyalty to this route
 * with an HMAC signature that authenticate.public.appProxy() verifies.
 *
 * Returns JSON: { code, title } on success, or { error } on failure.
 */
export async function action({ request }) {
  // ── 1. Authenticate the App Proxy request ──────────────────────────────
  // NOTE: authenticate.public.appProxy() throws a Response (not an Error)
  // when HMAC is invalid (e.g. direct browser access). Re-throw it so Remix
  // handles it correctly. Only catch real errors.
  let admin;
  try {
    const result = await authenticate.public.appProxy(request);
    admin = result.admin;
  } catch (err) {
    // If Shopify threw a Response (redirect/error), pass it through
    if (err instanceof Response) throw err;
    console.error("[proxy] Auth error:", err);
    return Response.json(
      { error: "Proxy authentication failed: " + (err?.message ?? String(err)) },
      { status: 401 }
    );
  }

  if (!admin) {
    // admin is only available if merchant has an active session stored in DB.
    // This usually means the app wasn't installed / session is missing on Render.
    console.error("[proxy] admin is undefined — app may not be installed or session DB is empty");
    return Response.json(
      { error: "App session not found. Please open the app in Shopify Admin and reinstall if needed." },
      { status: 401 }
    );
  }

  // ── 2. Parse & validate query param ────────────────────────────────────
  // NOTE: authenticate.public.appProxy() consumes the request body stream,
  // so request.json() would fail. Read `points` from the URL search params
  // instead — safe to read at any point regardless of HTTP method.
  const url = new URL(request.url);
  const pointsParam = url.searchParams.get("points");
  const points = parseInt(pointsParam, 10);

  if (!pointsParam || isNaN(points) || points <= 0) {
    return Response.json({ error: "Invalid points value." }, { status: 400 });
  }

  // ── 3. Build discount code details ─────────────────────────────────────
  const suffix = Math.random().toString(36).substring(2, 6).toUpperCase();
  const discountCode = `LOYALTY-${points}PCT-${suffix}`;
  const discountTitle = `Loyalty ${points}% Reward`;

  // percentage must be a Float (e.g. 0.10 for 10%) — NOT a string
  const percentage = points / 100;
  const startsAt = new Date().toISOString();

  // ── 4. Create discount via GraphQL ─────────────────────────────────────
  let response;
  try {
    response = await admin.graphql(
      `mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
        discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
          codeDiscountNode {
            codeDiscount {
              ... on DiscountCodeBasic {
                title
                codes(first: 1) {
                  nodes {
                    code
                  }
                }
              }
            }
          }
          userErrors {
            field
            message
            code
          }
        }
      }`,
      {
        variables: {
          basicCodeDiscount: {
            title: discountTitle,
            code: discountCode,
            startsAt,
            customerSelection: { all: true },
            customerGets: {
              value: { percentage },
              items: { all: true },
            },
            usageLimit: 1,
            appliesOncePerCustomer: true,
          },
        },
      }
    );
  } catch (err) {
    console.error("[proxy] GraphQL request threw:", err);
    return Response.json(
      { error: "GraphQL request failed: " + err.message },
      { status: 500 }
    );
  }

  // ── 5. Parse GraphQL response ───────────────────────────────────────────
  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error("[proxy] Failed to parse GraphQL response JSON:", err);
    return Response.json(
      { error: "Invalid response from Shopify API." },
      { status: 500 }
    );
  }

  console.log("[proxy] GraphQL response:", JSON.stringify(data));

  const result = data?.data?.discountCodeBasicCreate;
  const userErrors = result?.userErrors ?? [];

  if (userErrors.length > 0) {
    console.error("[proxy] userErrors:", userErrors);
    return Response.json(
      { error: userErrors.map((e) => e.message).join(" ") },
      { status: 422 }
    );
  }

  const codeDiscount = result?.codeDiscountNode?.codeDiscount;
  const code = codeDiscount?.codes?.nodes?.[0]?.code ?? discountCode;
  const title = codeDiscount?.title ?? discountTitle;

  return Response.json(
    { code, title, discountCode: code },
    {
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
}
