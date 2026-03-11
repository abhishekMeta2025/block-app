import { authenticate } from "../shopify.server";
import { useLoaderData, useActionData, Form } from "react-router";
import { Page, Card, TextField, Button, Banner, FormLayout, BlockStack } from "@shopify/polaris";
import { useState, useEffect } from "react";

/* ---------------- LOADER ---------------- */

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(`
    {
      shop {
        id
        metafield(namespace: "loyalty", key: "points_percentage") {
          value
        }
      }
    }
  `);

  const data = await response.json();

  return {
    shopId: data.data.shop.id,
    loyalty: data.data.shop.metafield?.value ?? ""
  };
}

/* ---------------- ACTION ---------------- */

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const loyalty = formData.get("loyalty");

  // Server-side validation: must be a non-negative integer
  const parsed = parseInt(loyalty, 10);
  if (loyalty === null || loyalty === "" || isNaN(parsed) || parsed < 0) {
    return {
      success: false,
      error: "Please enter a valid whole number (e.g. 10 for 10%).",
      loyalty: String(loyalty ?? "")
    };
  }

  // Get shop ID
  const shopResponse = await admin.graphql(`{ shop { id } }`);
  const shopData = await shopResponse.json();
  const shopId = shopData.data.shop.id;

  // Save to shop metafield
  const response = await admin.graphql(
    `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          namespace
          key
          value
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            namespace: "loyalty",
            key: "points_percentage",
            type: "number_integer",
            ownerId: shopId,
            value: String(parsed)
          }
        ]
      }
    }
  );

  const data = await response.json();
  const result = data?.data?.metafieldsSet;
  const userErrors = result?.userErrors ?? [];

  if (userErrors.length > 0) {
    return {
      success: false,
      error: userErrors.map((e) => e.message).join(" "),
      loyalty: String(parsed)
    };
  }

  const savedValue = result?.metafields?.[0]?.value ?? String(parsed);
  return { success: true, loyalty: savedValue, error: null };
}

/* ---------------- COMPONENT ---------------- */

export default function Index() {
  const { loyalty } = useLoaderData();
  const actionData = useActionData();
  const [value, setValue] = useState(String(loyalty ?? ""));
  const [dismissed, setDismissed] = useState(false);

  // Sync field with saved value after action
  useEffect(() => {
    if (actionData?.loyalty != null) {
      setValue(String(actionData.loyalty));
      setDismissed(false);
    }
  }, [actionData]);

  return (
    <Page title="Loyalty Points Settings">
      <BlockStack gap="400">
        {actionData?.success && !dismissed && (
          <Banner tone="success" onDismiss={() => setDismissed(true)}>
            Loyalty percentage saved! The storefront loyalty block will now use this value.
          </Banner>
        )}
        {actionData?.error && (
          <Banner tone="critical" onDismiss={() => setDismissed(true)}>
            {actionData.error}
          </Banner>
        )}
        <Card>
          {/* Use React Router <Form> — required for embedded apps so App Bridge auth is preserved */}
          <Form method="post">
            <FormLayout>
              <TextField
                label="Loyalty points percentage"
                name="loyalty"
                type="number"
                min="0"
                max="100"
                step="1"
                value={value}
                onChange={setValue}
                autoComplete="off"
                suffix="%"
                helpText="Customers earn this percentage of the product price as loyalty points. E.g. enter 10 for 10%."
              />
              <Button submit variant="primary">
                Save
              </Button>
            </FormLayout>
          </Form>
        </Card>
      </BlockStack>
    </Page>
  );
}