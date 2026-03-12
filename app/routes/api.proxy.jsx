import { authenticate } from "../shopify.server";

/**
 * App Proxy route — called by storefront JS when the loyalty discount
 * checkbox is checked. Shopify forwards /apps/block-loyalty to this route
 * with an HMAC signature that authenticate.public.appProxy() verifies.
 *
 * Returns JSON: { code, title } on success, or { error } on failure.
 */
export async function loader({ request }) {
  let admin;

  try {
    const result = await authenticate.public.appProxy(request);
    admin = result.admin;
  } catch (err) {
    return Response.json(
      { error: "Proxy authentication failed: " + err.message },
      { status: 401 }
    );
  }

  const url = new URL(request.url);
  const pointsParam = url.searchParams.get("points");
  const points = parseInt(pointsParam, 10);

  if (!pointsParam || isNaN(points) || points <= 0) {
    return Response.json({ error: "Invalid points value." }, { status: 400 });
  }

  // Generate a short unique suffix to make each code unique
  const suffix = Math.random().toString(36).substring(2, 6).toUpperCase();
  const discountCode = `LOYALTY-${points}PCT-${suffix}`;
  const discountTitle = `Loyalty ${points}% Reward`;

  // IMPORTANT: percentage must be a Float (number), e.g. 0.10 for 10%
  // Do NOT use .toFixed() — that returns a string which fails GraphQL type checks
  const percentage = points / 100;

  const startsAt = new Date().toISOString();

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
            // customerSelection: allCustomers (not "all: true")
            customerSelection: { allCustomers: true },
            customerGets: {
              // percentage must be a Float number, not a string
              value: { percentage },
              items: { all: true },
            },
            appliesOncePerCustomer: false,
          },
        },
      }
    );
  } catch (err) {
    return Response.json(
      { error: "GraphQL request failed: " + err.message },
      { status: 500 }
    );
  }

  const data = await response.json();
  const result = data?.data?.discountCodeBasicCreate;
  const userErrors = result?.userErrors ?? [];

  if (userErrors.length > 0) {
    return Response.json(
      { error: userErrors.map((e) => e.message).join(" ") },
      { status: 422 }
    );
  }

  const codeDiscount = result?.codeDiscountNode?.codeDiscount;
  const code = codeDiscount?.codes?.nodes?.[0]?.code ?? discountCode;
  const title = codeDiscount?.title ?? discountTitle;

  return Response.json(
    { code, title },
    {
      headers: {
        // Required for App Proxy responses — tells Shopify not to cache
        "Content-Type": "application/json",
      },
    }
  );
}
