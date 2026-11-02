// ---------------------------------------------------------------------------
// The production reads behind Sophie's situation brief: the same gateway
// routes her tools call (as the person, on their org), nothing new.
// ---------------------------------------------------------------------------

import type { ApiCallParams } from "../lib/api-client.js";
import { getBillingAccount, getOfferPerformance, listOffers, listRepliesToHandle } from "../lib/account-client.js";
import { getOfferSettings } from "../lib/copilot-client.js";
import { listAccountCampaigns } from "../lib/funnel-campaign-client.js";
import { listBrands } from "../lib/funnel-client.js";
import type { SituationReader } from "./situation.js";

export function gatewaySituationReader(params: ApiCallParams): SituationReader {
  return {
    listBrands: () => listBrands(params),
    listOffers: (brandId) => listOffers(brandId, params),
    getOfferSettings: (brandId, offerId) => getOfferSettings({ brandId, offerId }, params),
    listCampaigns: (brandId) => listAccountCampaigns({ brandId }, params),
    getOfferPerformance: (brandId, offerId) => getOfferPerformance({ brandId, offerId }, params),
    listRepliesToHandle: (brandId, offerId) => listRepliesToHandle({ brandId, offerId }, params),
    getBillingAccount: () => getBillingAccount(params),
  };
}
