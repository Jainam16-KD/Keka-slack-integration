const axios = require("axios");
const config = require("../config/config");
const logger = require("../utils/logger");

let cachedToken = null;
let tokenExpiry = null;

/**
 * Get OAuth token (cached)
 */
async function getAccessToken() {
    if (cachedToken && tokenExpiry > Date.now()) {
        return cachedToken;
    }

    try {
        const response = await axios.post(
        config.keka.authUrl,
        new URLSearchParams({
            grant_type: "kekaapi",
            scope: "kekaapi",
            client_id: config.keka.clientId,
            client_secret: config.keka.clientSecret,
            api_key: config.keka.apiKey,
        }),
        {
            headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            },
        }
        );

        cachedToken = response.data.access_token;
        tokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;

        logger.info("Fetched new Keka access token");

        return cachedToken;
    } catch (error) {
        logger.error("Failed to fetch Keka token", {
        error: error.response?.data || error.message,
        });
        throw new Error("Keka authentication failed");
    }
}

async function getEmployeeByEmail(email) {
    try {
        const token = await getAccessToken();

        const response = await axios.post(
            `${config.keka.baseUrl}/api/v1/hris/employees/search`,
            { workEmail: email },
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                    api_key: config.keka.apiKey,
                },
            }
        );

        const apiData = response.data;

        if (!apiData.succeeded || !apiData.data?.id) {
            throw new Error("Employee not found in Keka");
        }

        return apiData.data;

    } catch (error) {
        logger.error("Failed to fetch employee", {
            email,
            error: error.response?.data || error.message,
        });
        throw new Error("Unable to fetch employee from Keka");
    }
}

async function getLeaveBalance(employeeId) {
    try {
        const token = await getAccessToken();

        const response = await axios.get(
            `${config.keka.baseUrl}/api/v1/time/leavebalance`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                    api_key: config.keka.apiKey,
                }
            }
        );

        const balances = response.data?.data;

        // console.log(
        //     response.data.data.map(emp => ({
        //         employeeIdentifier: emp.employeeIdentifier,
        //         employeeNumber: emp.employeeNumber,
        //         employeeName: emp.employeeName
        //     }))
        // );

        // if (!Array.isArray(balances)) {
        //     throw new Error("Invalid leave balance response");
        // }

        // const employeeBalance = balances.find(
        //     emp => emp.employeeIdentifier === employeeId
        // );

        // if (!employeeBalance) {
        //     throw new Error("Employee leave balance not found");
        // }

        return balances;

    } catch (error) {
        logger.error("Failed to fetch leave balance", {
            employeeId,
            error: error.response?.data || error.message,
        });
        throw new Error("Unable to fetch leave balance");
    }
}

async function getLeaveRequests(employeeId) {
  try {
    const token = await getAccessToken();

    const response = await axios.get(
      `${config.keka.baseUrl}/api/v1/leave/requests?employeeId=${employeeId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          api_key: config.keka.apiKey,
        },
      }
    );

    return response.data;
  } catch (error) {
    logger.error("Failed to fetch leave requests", {
      employeeId,
      error: error.response?.data || error.message,
    });
    throw new Error("Unable to fetch leave requests");
  }
}

function toDateOnly(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().split("T")[0];
}

function hasMatchingLeave(records, { employeeId, leaveTypeId, fromDate, toDate }) {
  return records.some((record) => {
    const recordEmployeeId = String(
      record.employeeId || record.employeeIdentifier || record.employee?.id || ""
    );
    const recordLeaveTypeId = String(
      record.leaveTypeId || record.leaveType?.id || record.leaveTypeIdentifier || ""
    );
    const recordFromDate = toDateOnly(record.fromDate || record.startDate);
    const recordToDate = toDateOnly(record.toDate || record.endDate);
    const recordStatus = String(record.status || "").toLowerCase();

    if (recordStatus && ["cancelled", "rejected"].includes(recordStatus)) {
      return false;
    }

    return (
      recordEmployeeId === String(employeeId) &&
      recordLeaveTypeId === String(leaveTypeId) &&
      recordFromDate === fromDate &&
      recordToDate === toDate
    );
  });
}

async function hasExistingLeaveRequest({ employeeId, leaveTypeId, fromDate, toDate }) {
  try {
    const response = await getLeaveRequests(employeeId);
    const records = Array.isArray(response?.data)
      ? response.data
      : Array.isArray(response)
      ? response
      : [];

    return hasMatchingLeave(records, { employeeId, leaveTypeId, fromDate, toDate });
  } catch (error) {
    logger.error("Failed to verify existing leave request", {
      employeeId,
      leaveTypeId,
      fromDate,
      toDate,
      error: error.message,
    });
    return false;
  }
}

async function createLeaveRequest({
  employeeId,
  leaveTypeId,
  fromDate,
  toDate,
  fromSession = 0,
  toSession = 1,
  reason = "",
}) {
  try {
    const token = await getAccessToken();

    const payload = {
      employeeId,
      requestedBy: employeeId,
      fromDate,
      toDate,
      fromSession,
      toSession,
      leaveTypeId,
      reason,
      note: "Applied via Slack",
    };

    const response = await axios.post(
      `${config.keka.baseUrl}/api/v1/time/leaverequests`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          api_key: config.keka.apiKey,
        },
      }
    );

    return response.data;
  } catch (error) {
    logger.error("Failed to create leave", {
      employeeId,
      error: error.response?.data || error.message,
    });
    throw new Error("Unable to create leave request");
  }
}

async function getLeaveTypes() {
  try {
    const token = await getAccessToken();

    const response = await axios.get(
      `${config.keka.baseUrl}/api/v1/time/leavetypes`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          api_key: config.keka.apiKey,
        },
      }
    );

    return response.data;
  } catch (error) {
    logger.error("Failed to fetch leave types", {
      error: error.response?.data || error.message,
    });
    throw new Error("Unable to fetch leave types");
  }
}

module.exports = {
  getAccessToken,
  getEmployeeByEmail,
  getLeaveBalance,
  getLeaveRequests,
  hasExistingLeaveRequest,
  createLeaveRequest,
  getLeaveTypes,
};
