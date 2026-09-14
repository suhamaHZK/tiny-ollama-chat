const API_BASE_URL = "";

export const SERVER_ENDPOINTS = {
  conversatios: `${API_BASE_URL}/api/conversations`,
  models: `${API_BASE_URL}/api/models`,
};

export const apiFetch = async (url: string, options: RequestInit = {}) => {
  const headers = {
    "Content-Type": "application/json",
    ...options.headers,
  };

  console.log("API CALL MADE TO:", url);

  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    const error = await response.json();
    console.log(error);
    throw new Error(error.message || "Something went wrong");
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
};
