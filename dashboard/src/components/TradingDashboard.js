import React, { useEffect, useState, Fragment } from 'react';
import { Dialog, Menu } from '@headlessui/react';
import {
  TrendingDown,
  TrendingUp,
  MoreHorizontal,
  Bell,
  Menu as MenuIcon,
  X,
  Plus,
  ArrowUpCircle,
  ArrowDownCircle,
  RefreshCcw
} from 'lucide-react';

const navigation = [
  { name: 'Home', href: '/home' },
  { name: 'Dashboard', href: '/dashboard', current: true },
  { name: 'Positions', href: '/positions' },
  { name: 'Settings', href: '/settings' },
];

const timeFrames = [
  { name: 'Last 24h', href: '/timeframe/24h', current: true },
  { name: 'Last 7d', href: '/timeframe/7d', current: false },
  { name: 'All-time', href: '/timeframe/all', current: false },
];

// Utility functions
const formatCurrency = (num) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(num);
};

const formatNumber = (num) => {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(num);
};

const getStatusColor = (position) => {
  if (position.state.isClosing) return 'text-gray-600 bg-gray-50 ring-gray-500/10';
  if (position.state.hasReachedThreshold) return 'text-green-700 bg-green-50 ring-green-600/20';
  if (position.state.highestProgress < -5) return 'text-red-700 bg-red-50 ring-red-600/10';
  return 'text-blue-700 bg-blue-50 ring-blue-600/10';
};

const calculateStats = (positions) => {
  const positionValues = Object.values(positions);
  const totalBalance = positionValues[0]?.initialData.accountBalance || 0;
  const totalPnL = positionValues.reduce((acc, pos) => acc + pos.state.highestProgress, 0);
  const successfulPositions = positionValues.filter(pos => pos.state.highestProgress > 0);
  
  return [
    {
      name: 'Account Balance',
      value: formatCurrency(totalBalance),
      change: `${formatNumber(totalPnL)}%`,
      changeType: totalPnL >= 0 ? 'positive' : 'negative',
    },
    {
      name: 'Open Positions',
      value: positionValues.length.toString(),
      change: 'Active',
      changeType: 'positive',
    },
    {
      name: 'Total P&L',
      value: `${formatNumber(totalPnL)}%`,
      change: `${positionValues.length} positions`,
      changeType: totalPnL >= 0 ? 'positive' : 'negative',
    },
    {
      name: 'Success Rate',
      value: `${formatNumber((successfulPositions.length / positionValues.length) * 100)}%`,
      change: 'All positions',
      changeType: 'positive',
    },
  ];
};

// Group positions by date
const groupPositionsByDate = (positions) => {
  const grouped = {};
  Object.values(positions).forEach(position => {
    const date = new Date(position.openedAt).toLocaleDateString();
    if (!grouped[date]) {
      grouped[date] = [];
    }
    grouped[date].push(position);
  });
  
  return Object.entries(grouped).map(([date, positions]) => ({
    date,
    dateTime: new Date(positions[0].openedAt).toISOString(),
    positions
  })).sort((a, b) => new Date(b.dateTime) - new Date(a.dateTime));
};

function classNames(...classes) {
  return classes.filter(Boolean).join(' ');
}

export default function TradingDashboard() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [positions, setPositions] = useState({});
  const [stats, setStats] = useState([]);
  const [groupedPositions, setGroupedPositions] = useState([]);

  useEffect(() => {
    const loadPositions = async () => {
      try {
        const response = await fetch('/position-cache.json');
        const data = await response.json();
        setPositions(data);
        setStats(calculateStats(data));
        setGroupedPositions(groupPositionsByDate(data));
      } catch (error) {
        console.error('Error loading positions:', error);
      }
    };

    loadPositions();
    const interval = setInterval(loadPositions, 5000); // Refresh every 5 seconds

    return () => clearInterval(interval);
  }, []);

  return (
    <>
      <header className="absolute inset-x-0 top-0 z-50 flex h-16 border-b border-gray-900/10">
        {/* Header content remains the same */}
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex flex-1 items-center gap-x-6">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="-m-3 p-3 md:hidden"
            >
              <span className="sr-only">Open main menu</span>
              <MenuIcon className="h-6 w-6" />
            </button>
            <img
              className="h-8 w-auto"
              src="http://loremflickr.com/32/32"
              alt="Trading Dashboard"
            />
          </div>
          <nav className="hidden md:flex md:gap-x-11 md:text-sm/6 md:font-semibold md:text-gray-700">
            {navigation.map((item, itemIdx) => (
              <a key={itemIdx} href={item.href} className={item.current ? 'text-indigo-600' : ''}>
                {item.name}
              </a>
            ))}
          </nav>
          <div className="flex flex-1 items-center justify-end gap-x-8">
            <button
              type="button"
              className="-m-2.5 p-2.5 text-gray-400 hover:text-gray-500"
            >
              <span className="sr-only">View notifications</span>
              <Bell className="h-6 w-6" />
            </button>
            <a href="#" className="-m-1.5 p-1.5">
              <span className="sr-only">Your profile</span>
              <img
                className="h-8 w-8 rounded-full bg-gray-800"
                src="http://loremflickr.com/32/32"
                alt=""
              />
            </a>
          </div>
        </div>
      </header>

      <main className="relative isolate">
        <div className="overflow-hidden pt-16">
          {/* Secondary navigation */}
          <header className="pb-4 pt-6 sm:pb-6">
            <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-6 px-4 sm:flex-nowrap sm:px-6 lg:px-8">
              <h1 className="text-base font-semibold leading-7 text-gray-900">
                Trading Dashboard
              </h1>
              <div className="order-last flex w-full gap-x-8 text-sm font-semibold leading-6 sm:order-none sm:w-auto sm:border-l sm:border-gray-200 sm:pl-6 sm:leading-7">
                {timeFrames.map((item) => (
                  <a
                    key={item.name}
                    href={item.href}
                    className={item.current ? 'text-indigo-600' : 'text-gray-700'}
                  >
                    {item.name}
                  </a>
                ))}
              </div>
              <button
                type="button"
                className="ml-auto flex items-center gap-x-1 rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
              >
                <Plus className="-ml-1.5 h-5 w-5" />
                New Position
              </button>
            </div>
          </header>

          {/* Stats */}
          <div className="border-b border-b-gray-900/10 lg:border-t lg:border-t-gray-900/5">
            <dl className="mx-auto grid max-w-7xl grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 lg:px-2 xl:px-0">
              {stats.map((stat, statIdx) => (
                <div
                  key={stat.name}
                  className={classNames(
                    statIdx % 2 === 1 ? 'sm:border-l' : statIdx === 2 ? 'lg:border-l' : '',
                    'flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-t border-gray-900/5 px-4 py-10 sm:px-6 lg:border-t-0 xl:px-8'
                  )}
                >
                  <dt className="text-sm font-medium leading-6 text-gray-500">{stat.name}</dt>
                  <dd
                    className={classNames(
                      stat.changeType === 'negative' ? 'text-rose-600' : 'text-gray-700',
                      'text-xs font-medium'
                    )}
                  >
                    {stat.change}
                  </dd>
                  <dd className="w-full flex-none text-3xl font-medium leading-10 tracking-tight text-gray-900">
                    {stat.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Recent activity table */}
          <div className="space-y-16 py-16 xl:space-y-20">
            <div>
              <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
                <h2 className="mx-auto max-w-2xl text-base font-semibold leading-6 text-gray-900 lg:mx-0 lg:max-w-none">
                  Recent Positions
                </h2>
              </div>
              <div className="mt-6 overflow-hidden border-t border-gray-100">
                <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
                  <div className="mx-auto max-w-2xl lg:mx-0 lg:max-w-none">
                    <table className="w-full text-left">
                      <thead className="sr-only">
                        <tr>
                          <th>Amount</th>
                          <th className="hidden sm:table-cell">Symbol</th>
                          <th>More details</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groupedPositions.map((group) => (
                          <Fragment key={group.dateTime}>
                            <tr className="text-sm leading-6 text-gray-900">
                              <th scope="colgroup" colSpan={3} className="relative isolate py-2 font-semibold">
                                <time dateTime={group.dateTime}>{group.date}</time>
                                <div className="absolute inset-y-0 right-full -z-10 w-screen border-b border-gray-200 bg-gray-50" />
                                <div className="absolute inset-y-0 left-0 -z-10 w-screen border-b border-gray-200 bg-gray-50" />
                              </th>
                            </tr>
                            {group.positions.map((position) => (
                              <tr key={position.id}>
                                <td className="relative py-5 pr-6">
                                  <div className="flex gap-x-6">
                                    {position.direction === 'long' ? (
                                      <ArrowUpCircle className="hidden h-6 w-5 flex-none text-green-400 sm:block" />
                                    ) : (
                                      <ArrowDownCircle className="hidden h-6 w-5 flex-none text-red-400 sm:block" />
                                    )}
                                    <div className="flex-auto">
                                      <div className="flex items-start gap-x-3">
                                        <div className="text-sm leading-6 font-medium text-gray-900">
                                          {formatCurrency(position.state.lastCheckedPrice)}
                                        </div>
                                        <div
                                          className={classNames(
                                            getStatusColor(position),
                                            'rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset'
                                          )}
                                        >
                                          {position.state.hasReachedThreshold ? 'Threshold' : 'Active'}
                                        </div>
                                      </div>
                                      <div className="mt-1 text-xs leading-5 text-gray-500">
                                        {formatNumber(position.initialData.size)} {position.symbol}
                                      </div>
                                    </div>
                                  </div>
                                  <div className="absolute bottom-0 right-full h-px w-screen bg-gray-100" />
                                  <div className="absolute bottom-0 left-0 h-px w-screen bg-gray-100" />
                                </td>
                                <td className="hidden py-5 pr-6 sm:table-cell">
                                  <div className="text-sm leading-6 text-gray-900">{position.symbol}</div>
                                  <div className="mt-1 text-xs leading-5 text-gray-500">
                                    {position.state.trailingStatusMessage}
                                  </div>
                                </td>
                                <td className="py-5 text-right">
                                  <div className="flex justify-end">
                                    <Menu as="div" className="relative">
                                    <Menu.Button className="-m-2.5 block p-2.5 text-gray-400 hover:text-gray-500">
                                        <span className="sr-only">Open options</span>
                                        <MoreHorizontal className="h-5 w-5" />
                                      </Menu.Button>
                                      <Menu.Items className="absolute right-0 z-10 mt-0.5 w-32 origin-top-right rounded-md bg-white py-2 shadow-lg ring-1 ring-gray-900/5 focus:outline-none">
                                        <Menu.Item>
                                          {({ active }) => (
                                            <a
                                              href="#"
                                              className={classNames(
                                                active ? 'bg-gray-50' : '',
                                                'block px-3 py-1 text-sm leading-6 text-gray-900'
                                              )}
                                              onClick={(e) => {
                                                e.preventDefault();
                                                console.log('View details:', position.id);
                                              }}
                                            >
                                              View details
                                            </a>
                                          )}
                                        </Menu.Item>
                                        <Menu.Item>
                                          {({ active }) => (
                                            <a
                                              href="#"
                                              className={classNames(
                                                active ? 'bg-gray-50' : '',
                                                'block px-3 py-1 text-sm leading-6 text-gray-900'
                                              )}
                                              onClick={(e) => {
                                                e.preventDefault();
                                                console.log('Close position:', position.id);
                                              }}
                                            >
                                              Close position
                                            </a>
                                          )}
                                        </Menu.Item>
                                      </Menu.Items>
                                    </Menu>
                                  </div>
                                  <div className="mt-1 text-xs leading-5 text-gray-500">
                                    Progress:{' '}
                                    <span className={position.state.highestProgress >= 0 ? 'text-green-600' : 'text-red-600'}>
                                      {formatNumber(position.state.highestProgress)}%
                                    </span>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>

            {/* Active position cards */}
            <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
              <div className="mx-auto max-w-2xl lg:mx-0 lg:max-w-none">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-semibold leading-7 text-gray-900">Active Positions</h2>
                  <button
                    type="button"
                    onClick={() => console.log('Refresh positions')}
                    className="text-sm font-semibold leading-6 text-indigo-600 hover:text-indigo-500"
                  >
                    <RefreshCcw className="inline-block h-4 w-4 mr-1" />
                    Refresh
                  </button>
                </div>
                <ul role="list" className="mt-6 grid grid-cols-1 gap-x-6 gap-y-8 lg:grid-cols-3 xl:gap-x-8">
                  {Object.values(positions).map((position) => (
                    <li key={position.id} className="overflow-hidden rounded-xl border border-gray-200">
                      <div className="flex items-center gap-x-4 border-b border-gray-900/5 bg-gray-50 p-6">
                        {position.direction === 'long' ? (
                          <TrendingUp className="h-6 w-6 text-green-500" />
                        ) : (
                          <TrendingDown className="h-6 w-6 text-red-500" />
                        )}
                        <div className="text-sm font-medium leading-6 text-gray-900">
                          {position.symbol} {position.direction.toUpperCase()}
                        </div>
                        <Menu as="div" className="relative ml-auto">
                          <Menu.Button className="-m-2.5 block p-2.5 text-gray-400 hover:text-gray-500">
                            <span className="sr-only">Open options</span>
                            <MoreHorizontal className="h-5 w-5" />
                          </Menu.Button>
                          <Menu.Items className="absolute right-0 z-10 mt-0.5 w-32 origin-top-right rounded-md bg-white py-2 shadow-lg ring-1 ring-gray-900/5 focus:outline-none">
                            <Menu.Item>
                              {({ active }) => (
                                <a
                                  href="#"
                                  className={classNames(
                                    active ? 'bg-gray-50' : '',
                                    'block px-3 py-1 text-sm leading-6 text-gray-900'
                                  )}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    console.log('View details:', position.id);
                                  }}
                                >
                                  View details
                                </a>
                              )}
                            </Menu.Item>
                            <Menu.Item>
                              {({ active }) => (
                                <a
                                  href="#"
                                  className={classNames(
                                    active ? 'bg-gray-50' : '',
                                    'block px-3 py-1 text-sm leading-6 text-gray-900'
                                  )}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    console.log('Close position:', position.id);
                                  }}
                                >
                                  Close position
                                </a>
                              )}
                            </Menu.Item>
                          </Menu.Items>
                        </Menu>
                      </div>
                      <dl className="-my-3 divide-y divide-gray-100 px-6 py-4 text-sm leading-6">
                        <div className="flex justify-between gap-x-4 py-3">
                          <dt className="text-gray-500">Entry Price</dt>
                          <dd className="text-gray-700">{formatCurrency(position.state.entryPrice)}</dd>
                        </div>
                        <div className="flex justify-between gap-x-4 py-3">
                          <dt className="text-gray-500">Current Price</dt>
                          <dd className="text-gray-700">{formatCurrency(position.state.lastCheckedPrice)}</dd>
                        </div>
                        <div className="flex justify-between gap-x-4 py-3">
                          <dt className="text-gray-500">Size</dt>
                          <dd className="text-gray-700">{formatNumber(position.initialData.size)} {position.symbol}</dd>
                        </div>
                        <div className="flex justify-between gap-x-4 py-3">
                          <dt className="text-gray-500">Progress</dt>
                          <dd className={position.state.highestProgress >= 0 ? 'text-green-600' : 'text-red-600'}>
                            {formatNumber(position.state.highestProgress)}%
                          </dd>
                        </div>
                        <div className="flex justify-between gap-x-4 py-3">
                          <dt className="text-gray-500">Status</dt>
                          <dd className="text-gray-700">{position.state.trailingStatusMessage}</dd>
                        </div>
                      </dl>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>

        {/* Mobile menu dialog */}
        <Dialog as="div" className="lg:hidden" open={mobileMenuOpen} onClose={setMobileMenuOpen}>
          <div className="fixed inset-0 z-50" />
          <Dialog.Panel className="fixed inset-y-0 left-0 z-50 w-full overflow-y-auto bg-white px-4 pb-6 sm:max-w-sm sm:px-6 sm:ring-1 sm:ring-gray-900/10">
            <div className="-ml-0.5 flex h-16 items-center gap-x-6">
              <button
                type="button"
                className="-m-2.5 p-2.5 text-gray-700"
                onClick={() => setMobileMenuOpen(false)}
              >
                <span className="sr-only">Close menu</span>
                <X className="h-6 w-6" />
              </button>
              <div className="-ml-0.5">
                <img
                  className="h-8 w-auto"
                  src="http://loremflickr.com/32/32"
                  alt=""
                />
              </div>
            </div>
            <div className="mt-2 space-y-2">
              {navigation.map((item) => (
                <a
                  key={item.name}
                  href={item.href}
                  className={classNames(
                    item.current
                      ? 'bg-gray-50 text-indigo-600'
                      : 'text-gray-700 hover:text-indigo-600',
                    'block rounded-lg px-3 py-2 text-base font-semibold leading-7'
                  )}
                >
                  {item.name}
                </a>
              ))}
            </div>
          </Dialog.Panel>
        </Dialog>
      </main>
    </>
  );
}