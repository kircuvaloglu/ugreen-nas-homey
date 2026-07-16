const Homey = require('homey');

class UgreenNasApp extends Homey.App {
  /**
   * onInit is called when the app is initialized
   */
  async onInit() {
    this.log('Ugreen NAS app has been initialized');

    this.homey.flow.getActionCard('shutdown_nas')
      .registerRunListener(async ({ device }) => {
        await device.getClient().shutdown();
      });

    this.homey.flow.getActionCard('reboot_nas')
      .registerRunListener(async ({ device }) => {
        await device.getClient().reboot();
      });

    this.homey.flow.getConditionCard('disk_activity_above')
      .registerRunListener(async ({ device, rate }) => {
        const read = device.getCapabilityValue('disk_read_rate') || 0;
        const write = device.getCapabilityValue('disk_write_rate') || 0;
        return (read + write) > rate;
      });

    this.homey.flow.getConditionCard('network_activity_above')
      .registerRunListener(async ({ device, rate }) => {
        const rx = device.getCapabilityValue('measure_network_rx') || 0;
        const tx = device.getCapabilityValue('measure_network_tx') || 0;
        return (rx + tx) > rate;
      });

    this.homey.flow.getConditionCard('cpu_usage_above')
      .registerRunListener(async ({ device, percent }) => {
        const cpu = device.getCapabilityValue('measure_cpu') || 0;
        return cpu > percent;
      });
  }

  getUgreenNasDevices() {
    const driver = this.homey.drivers.getDriver('ugreen_nas');
    return driver.getDevices();
  }

  getUgreenNasDeviceById(deviceId) {
    const devices = this.getUgreenNasDevices();
    return devices.find(device => device.getId() === deviceId) || null;
  }

  getDashboardDataForWidget(deviceIds = []) {
    const devices = this.getUgreenNasDevices();
    const selectedDevice = Array.isArray(deviceIds) && deviceIds.length > 0
      ? devices.find(device => deviceIds.includes(device.getId()))
      : devices[0];

    if (!selectedDevice) {
      return {
        ready: false,
        message: 'No Ugreen NAS device has been added yet.',
      };
    }

    return {
      ready: true,
      device: {
        id: selectedDevice.getId(),
        name: selectedDevice.getName(),
        available: selectedDevice.getAvailable(),
      },
      updatedAt: new Date().toISOString(),
      data: selectedDevice.getDashboardData(),
    };
  }
}

module.exports = UgreenNasApp;
