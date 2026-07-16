'use strict';

module.exports = {
  async getStatus({ homey, body }) {
    return homey.app.getDashboardDataForWidget(body && body.deviceIds);
  },
};
