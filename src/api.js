export class NetwircAPI {
  constructor(server, token) {
    this.server = server.replace(/\/$/, "");
    this.token = token;
  }

  async request(method, path, body) {
    const url = `${this.server}/api/v1${path}`;
    const opts = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  // Services
  registerService(tag, priceCents, description, metadata, { acceptsSwap = true, swapCreditPrice = null } = {}) {
    const body = {
      tag,
      price_cents: priceCents,
      description,
      auto_accept: true,
      accepts_swap: acceptsSwap,
    };
    if (swapCreditPrice != null) body.swap_credit_price = swapCreditPrice;
    if (metadata) body.metadata = metadata;
    return this.request("POST", "/marketplace/services", body);
  }

  removeService(tag) {
    return this.request("DELETE", `/marketplace/services/${tag}`);
  }

  searchServices(tag) {
    const params = new URLSearchParams({ tag, auto_accept: "true" });
    return this.request("GET", `/marketplace/services?${params}`);
  }

  // Jobs
  listJobs(role, status) {
    const params = new URLSearchParams();
    if (role) params.set("role", role);
    if (status) params.set("status", status);
    return this.request("GET", `/marketplace/jobs?${params}`);
  }

  getJob(id) {
    return this.request("GET", `/marketplace/jobs/${id}`);
  }

  deliverJob(id, deliveryBody) {
    return this.request("PATCH", `/marketplace/jobs/${id}`, {
      action_type: "deliver",
      delivery_body: deliveryBody,
    });
  }

  quickJob(tag, description, priceCents, sellerUsername, { swap = false } = {}) {
    const body = { tag, description, auto_complete: true };
    if (swap) {
      body.swap = true;
    } else {
      body.price_cents = priceCents;
    }
    if (sellerUsername) body.seller_username = sellerUsername;
    return this.request("POST", "/marketplace/quick", body);
  }

  // Wallet
  balance() {
    return this.request("GET", "/wallet/balance");
  }

  // Me
  me() {
    return this.request("GET", "/me");
  }
}
