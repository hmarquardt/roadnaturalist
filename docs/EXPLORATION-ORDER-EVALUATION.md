# Exploration order: `exploration-order-v1` over `naturalist-interest-v2`

Generated 2026-10-13T22:25:16.292Z. Derived plane `a13a883c16f6d6e897407eab0de325ea355f5edeb292ecfb36b092f9ea959ee9`, radius 25 mi, top 10, near-tie interval 1 interest point.

**Two different numbers.** `naturalistInterest` scores the mapped environmental context around a corridor and does not change with the search centre. `explorationOrder` is that score minus a bounded distance penalty, normalized by the radius the search asked for, so the list leads with roads it is practical to consider first. The interest score is never relabelled as the order, and the order never changes it.

## Success criteria, stated before the results

- **portlandRimBiasReduced** — Portland top-10 median distance falls materially from its naturalist-interest value (24.2 mi)
- **distanceImprovesMostRegions** — the median top-10 distance falls in at least 5 of 8 regions
- **interestRetentionHigh** — mean naturalist-interest score of the top 10 falls by no more than ~2 points in every region
- **strongRoadsSurvive** — the naturalist-interest #1 stays inside the exploration top 10 in every region
- **noCenterHugging** — the top 10 is not dominated by roads at the centre: its mean interest stays within the retention rule
- **nearTiesResolveTowardNearer** — among near-tied pairs (within 1 interest point) where the nearer road scores lower, the nearer road is preferred more often than not
- **deterministic** — the same results and radius always produce the same order

## The candidate transforms, measured on the same eight regions

| transform | cap | mean overlap with interest top | mean median distance before → after (mi) | regions closer | mean interest delta | worst interest delta | interest #1 kept in top 10 | near-tie resolved toward nearer |
|---|---|---|---|---|---|---|---|---|
| linear | 10 | 4.5/10 | 18.13 → 8.44 | 8/8 | -1.29 | -2.21 | 7/8 | 0.88 (596 pairs) |
| quadratic | 10 | 4.63/10 | 18.13 → 9.37 | 8/8 | -1.25 | -2.48 | 5/8 | 0.9 (596 pairs) |
| tiered | 10 | 4/10 | 18.13 → 7.46 | 8/8 | -1.73 | -2.99 | 5/8 | 0.79 (596 pairs) |
| gentle **(selected)** | 6 | 6/10 | 18.13 → 10.13 | 8/8 | -0.68 | -1.52 | 7/8 | 0.83 (596 pairs) |

Selected: **gentle**. Interest baseline for comparison:

| region | searched | overlap with default | median dist, interest top (mi) |
|---|---|---|---|
| Princeton, IN | 2077 | 2/10 | 16.95 |
| Evansville, IN | 1977 | 1/10 | 17.34 |
| Nashville, TN | 1998 | 6/10 | 14.75 |
| Portland, OR | 2347 | 0/10 | 24.2 |
| Gulf coastal wetlands (Houma, LA) | 532 | 1/10 | 18.4 |
| Arid Southwest (Phoenix, AZ) | 2619 | 5/10 | 19.3 |
| Great Plains (Omaha, NE) | 1880 | 0/10 | 17.23 |
| Northeast (Boston, MA) | 2252 | 0/10 | 16.9 |
## Regions under the selected transform

### Princeton, IN

Center `[-87.5675, 38.3553]`, radius 25 mi, 2077 corridors. Overlap with the interest top: **6/10**.

Distance: median 16.95 → **12.09** mi, mean 15.9 → **11.65**, p90 22.78 → **16.95**, max 23.53 → **16.95**. Interest: top-10 mean 80.48 → **80.13** (delta -0.35, retained 100%). Interest #1 kept in top 3/5/10: true/true/true. Near-tie pairs 106, resolved toward the nearer road 87 (share 0.82).

| # | road | interest | exploration | dist mi | fraction of radius | penalty |
|---|---|---|---|---|---|---|
| 1 | Co Rd 100 N | 81.9 | 81.9 | 1.21 | 0.049 | 0 |
| 2 | Co Rd 1500 W | 81.9 | 80.1 | 13.67 | 0.547 | 1.8 |
| 3 | S Meridian Rd | 81.2 | 78.8 | 15.66 | 0.626 | 2.4 |
| 4 | Co Rd 900 | 79.6 | 78.7 | 9.77 | 0.391 | 0.9 |
| 5 | Wabash River Rd | 79.3 | 78.1 | 11.04 | 0.442 | 1.2 |
| 6 | River Rd | 78.5 | 77.8 | 8.35 | 0.334 | 0.7 |
| 7 | Co Rd 150 N | 78.8 | 77.7 | 10.77 | 0.431 | 1.1 |
| 8 | County Line Rd | 80.5 | 77.7 | 16.95 | 0.678 | 2.8 |
| 9 | State Rd 57 | 79.1 | 77.7 | 12.09 | 0.483 | 1.4 |
| 10 | Warrick County Line Rd | 80.5 | 77.7 | 16.95 | 0.678 | 2.8 |

Entered the top: drv1-wabash-river-rd-s1, drv1-river-rd-c226-s1, drv1-co-rd-150-n-c11-s1, drv1-state-rd-57-c1-s1

Left the top: drv1-heim-rd-c1-s1, drv1-co-rd-50-n-c8-s1, drv1-weyerbacher-rd-s1, drv1-w-diamond-ave-c1-s1

### Evansville, IN

Center `[-87.5347, 37.9877]`, radius 25 mi, 1977 corridors. Overlap with the interest top: **4/10**.

Distance: median 17.34 → **5.07** mi, mean 16.38 → **5.47**, p90 24.67 → **8.7**, max 24.9 → **13.53**. Interest: top-10 mean 81.49 → **80.23** (delta -1.26, retained 99%). Interest #1 kept in top 3/5/10: false/false/false. Near-tie pairs 115, resolved toward the nearer road 95 (share 0.83).

| # | road | interest | exploration | dist mi | fraction of radius | penalty |
|---|---|---|---|---|---|---|
| 1 | US Hwy 41 | 82.1 | 81.9 | 5.07 | 0.203 | 0.2 |
| 2 | County Line Rd | 80.5 | 80.3 | 4.9 | 0.196 | 0.2 |
| 3 | Warrick County Line Rd | 80.5 | 80.3 | 4.9 | 0.196 | 0.2 |
| 4 | Heim Rd | 80.3 | 79.9 | 6.54 | 0.262 | 0.4 |
| 5 | State Rd 66 | 80.5 | 79.8 | 8.7 | 0.348 | 0.7 |
| 6 | Co Rd 50 N | 79.9 | 79.5 | 6.54 | 0.262 | 0.4 |
| 7 | W Diamond Ave | 79.4 | 79.4 | 1.64 | 0.066 | 0 |
| 8 | Old State Rd 66 | 80.9 | 79.1 | 13.53 | 0.541 | 1.8 |
| 9 | State Rd 66 | 79.1 | 79.1 | 1.23 | 0.049 | 0 |
| 10 | W Diamond Ave | 79.1 | 79.1 | 1.64 | 0.065 | 0 |

Entered the top: drv1-warrick-county-line-rd-c1-s1, drv1-heim-rd-c1-s1, drv1-co-rd-50-n-c8-s1, drv1-w-diamond-ave-c1-s1, drv1-state-rd-66-c1-s33, drv1-w-diamond-ave-c1-s3

Left the top: drv1-raben-rd-n-s1, drv1-wabash-rd-c8-s1, drv1-co-rd-1500-w-c3-s1, drv1-indian-mound-rd-c4-s1, drv1-state-rte-14-c9-s19, drv1-alzey-mt-vernon-rd-s1

### Nashville, TN

Center `[-86.785, 36.1718]`, radius 25 mi, 1998 corridors. Overlap with the interest top: **8/10**.

Distance: median 14.75 → **11.35** mi, mean 13.08 → **11.29**, p90 17.66 → **15.15**, max 18.13 → **16.6**. Interest: top-10 mean 75.58 → **75.35** (delta -0.23, retained 100%). Interest #1 kept in top 3/5/10: true/true/true. Near-tie pairs 40, resolved toward the nearer road 31 (share 0.78).

| # | road | interest | exploration | dist mi | fraction of radius | penalty |
|---|---|---|---|---|---|---|
| 1 | State Rte 1 | 79.6 | 77.5 | 14.75 | 0.59 | 2.1 |
| 2 | US Hwy 70 | 78.6 | 76.5 | 14.75 | 0.59 | 2.1 |
| 3 | Benders Ferry Rd | 78.2 | 75.6 | 16.6 | 0.664 | 2.6 |
| 4 | Saundersville Rd | 75.7 | 74.6 | 10.81 | 0.433 | 1.1 |
| 5 | US Hwy 41 | 74.1 | 74.1 | 0.32 | 0.013 | 0 |
| 6 | Sanders Ferry Rd | 74.1 | 72.9 | 11.28 | 0.451 | 1.2 |
| 7 | State Rte 251 | 73.7 | 72.5 | 11.35 | 0.454 | 1.2 |
| 8 | State Rte 12 | 72.8 | 72 | 8.87 | 0.355 | 0.8 |
| 9 | State Rte 12 | 74.1 | 71.9 | 15.15 | 0.606 | 2.2 |
| 10 | Bell Rd | 72.6 | 71.8 | 9.02 | 0.361 | 0.8 |

Entered the top: drv1-state-rte-12-c16-s2, drv1-bell-rd-c18-s3

Left the top: drv1-state-rte-96-c5-s26, drv1-chapmansboro-rd-s1

### Portland, OR

Center `[-122.65, 45.5369]`, radius 25 mi, 2347 corridors. Overlap with the interest top: **3/10**.

Distance: median 24.2 → **10.64** mi, mean 22.38 → **11.15**, p90 24.64 → **17.47**, max 24.64 → **21.57**. Interest: top-10 mean 81.3 → **79.78** (delta -1.52, retained 98%). Interest #1 kept in top 3/5/10: true/true/true. Near-tie pairs 104, resolved toward the nearer road 93 (share 0.89).

| # | road | interest | exploration | dist mi | fraction of radius | penalty |
|---|---|---|---|---|---|---|
| 1 | NW Germantown Rd | 79.9 | 79.5 | 6.74 | 0.27 | 0.4 |
| 2 | NE Lucia Falls Rd | 83.2 | 78.7 | 21.57 | 0.863 | 4.5 |
| 3 | NW Saint Helens Rd | 79.6 | 78.5 | 10.64 | 0.426 | 1.1 |
| 4 | US Hwy 30 | 80.1 | 78.5 | 13.01 | 0.521 | 1.6 |
| 5 | US Hwy 30 | 79.2 | 78.4 | 9.05 | 0.362 | 0.8 |
| 6 | SE Evergreen Hwy | 78.5 | 78.2 | 5.76 | 0.231 | 0.3 |
| 7 | Lewis and Clark Hwy | 80.5 | 78.1 | 15.84 | 0.634 | 2.4 |
| 8 | McLoughlin Blvd | 78.5 | 78.1 | 6.13 | 0.245 | 0.4 |
| 9 | SW Riverside Dr | 78 | 77.7 | 5.29 | 0.211 | 0.3 |
| 10 | SE Gordon Creek Rd | 80.3 | 77.4 | 17.47 | 0.699 | 2.9 |

Entered the top: drv1-nw-germantown-rd-s1, drv1-nw-saint-helens-rd-c1-s2, drv1-us-hwy-30-c9-s4, drv1-us-hwy-30-c9-s3, drv1-se-evergreen-hwy-s1, drv1-mcloughlin-blvd-s1, drv1-sw-riverside-dr-c1-s1

Left the top: drv1-hwy-47-c3-s1, drv1-nw-hwy-47-s1, drv1-sw-spring-hill-rd-s1, drv1-state-hwy-47-c4-s17, drv1-tualatin-valley-hwy-c1-s4, drv1-nw-wilson-river-hwy-s4, drv1-nw-cedar-canyon-rd-s1

### Gulf coastal wetlands (Houma, LA)

Center `[-90.7195, 29.5958]`, radius 25 mi, 532 corridors. Overlap with the interest top: **6/10**.

Distance: median 18.4 → **12.17** mi, mean 17.62 → **11.08**, p90 23.95 → **18.4**, max 24.99 → **20.35**. Interest: top-10 mean 83.84 → **83.04** (delta -0.8, retained 99%). Interest #1 kept in top 3/5/10: true/true/true. Near-tie pairs 60, resolved toward the nearer road 50 (share 0.83).

| # | road | interest | exploration | dist mi | fraction of radius | penalty |
|---|---|---|---|---|---|---|
| 1 | Savanne Rd | 84.5 | 84.4 | 3.67 | 0.147 | 0.1 |
| 2 | Gheens Main Rd | 85.8 | 82.5 | 18.4 | 0.736 | 3.3 |
| 3 | State Rte 182 | 85.3 | 82.2 | 17.9 | 0.716 | 3.1 |
| 4 | State Rte 398 | 85.2 | 81.2 | 20.35 | 0.814 | 4 |
| 5 | State Rte 653 | 81.4 | 81.1 | 5.46 | 0.218 | 0.3 |
| 6 | State Rte 20 | 83.1 | 81 | 14.76 | 0.591 | 2.1 |
| 7 | US Hwy 90 | 82.4 | 81 | 12.17 | 0.487 | 1.4 |
| 8 | US Hwy 90 | 82.2 | 80.8 | 12.07 | 0.483 | 1.4 |
| 9 | State Rte 182 | 80.6 | 80.4 | 4.49 | 0.179 | 0.2 |
| 10 | State Rte 315 | 79.9 | 79.9 | 1.51 | 0.06 | 0 |

Entered the top: drv1-state-rte-653-c8-s1, drv1-us-hwy-90-c13-s5, drv1-state-rte-182-c2-s2, drv1-state-rte-315-c2-s5

Left the top: drv1-state-rte-400-c1-s1, drv1-state-rte-1011-c5-s1, drv1-state-rte-182-c1-s28, drv1-state-rte-20-c16-s8

### Arid Southwest (Phoenix, AZ)

Center `[-112.074, 33.4484]`, radius 25 mi, 2619 corridors. Overlap with the interest top: **8/10**.

Distance: median 19.3 → **14.43** mi, mean 17.93 → **15.78**, p90 22.81 → **21.59**, max 22.86 → **22.81**. Interest: top-10 mean 77.31 → **76.86** (delta -0.45, retained 99%). Interest #1 kept in top 3/5/10: true/true/true. Near-tie pairs 30, resolved toward the nearer road 27 (share 0.9).

| # | road | interest | exploration | dist mi | fraction of radius | penalty |
|---|---|---|---|---|---|---|
| 1 | S 91st Ave | 77.6 | 76.6 | 10.45 | 0.418 | 1 |
| 2 | N Fort McDowell Rd | 81 | 76 | 22.81 | 0.912 | 5 |
| 3 | Santa Cruz Rd | 77.4 | 75.7 | 13.17 | 0.527 | 1.7 |
| 4 | S 123rd Ave | 77.2 | 75.2 | 14.43 | 0.577 | 2 |
| 5 | S El Mirage Rd | 77.2 | 75.2 | 14.43 | 0.577 | 2 |
| 6 | Estrella Pkwy | 77.8 | 74.4 | 18.72 | 0.749 | 3.4 |
| 7 | S 83rd Ave | 73.9 | 73 | 9.47 | 0.379 | 0.9 |
| 8 | John Wayne Pkwy | 76.3 | 72.7 | 19.3 | 0.772 | 3.6 |
| 9 | S 115th Ave | 74.1 | 72.4 | 13.41 | 0.536 | 1.7 |
| 10 | State Rte 587 | 76.1 | 71.6 | 21.59 | 0.864 | 4.5 |

Entered the top: drv1-s-83rd-ave-c2-s1, drv1-s-115th-ave-c1-s1

Left the top: drv1-beeline-hwy-c1-s1, drv1-state-rte-87-c2-s22

### Great Plains (Omaha, NE)

Center `[-95.937, 41.2565]`, radius 25 mi, 1880 corridors. Overlap with the interest top: **7/10**.

Distance: median 17.23 → **4.82** mi, mean 13.68 → **8.93**, p90 22.05 → **19.82**, max 22.06 → **22.06**. Interest: top-10 mean 75.71 → **75.27** (delta -0.44, retained 99%). Interest #1 kept in top 3/5/10: true/true/true. Near-tie pairs 46, resolved toward the nearer road 33 (share 0.72).

| # | road | interest | exploration | dist mi | fraction of radius | penalty |
|---|---|---|---|---|---|---|
| 1 | John J Pershing Dr | 78.9 | 78.7 | 4.22 | 0.169 | 0.2 |
| 2 | Joslin Ave | 74.3 | 74.1 | 4.25 | 0.17 | 0.2 |
| 3 | State Hwy 92 | 74 | 73.9 | 3.04 | 0.121 | 0.1 |
| 4 | US Hwy 75 | 75.4 | 73.9 | 12.67 | 0.507 | 1.5 |
| 5 | US Hwy 75 | 75.1 | 73.9 | 11.1 | 0.444 | 1.2 |
| 6 | US Hwy 275 | 73.9 | 73.7 | 4.82 | 0.193 | 0.2 |
| 7 | W Center Rd | 73.9 | 73.7 | 4.13 | 0.165 | 0.2 |
| 8 | W South Omaha Bridge Rd | 73.3 | 73.2 | 3.17 | 0.127 | 0.1 |
| 9 | State Hwy 64 | 77.4 | 72.7 | 22.06 | 0.882 | 4.7 |
| 10 | US Hwy 34 | 76.5 | 72.7 | 19.82 | 0.793 | 3.8 |

Entered the top: drv1-us-hwy-275-c3-s11, drv1-w-center-rd-c1-s5, drv1-w-south-omaha-bridge-rd-s1

Left the top: drv1-us-hwy-6-c28-s10, drv1-state-hwy-92-c4-s36, drv1-river-rd-c813-s1

### Northeast (Boston, MA)

Center `[-71.0589, 42.3601]`, radius 25 mi, 2252 corridors. Overlap with the interest top: **6/10**.

Distance: median 16.9 → **10.5** mi, mean 15.52 → **10.01**, p90 23.77 → **14.15**, max 24.8 → **18.21**. Interest: top-10 mean 80.71 → **80.29** (delta -0.42, retained 100%). Interest #1 kept in top 3/5/10: false/true/true. Near-tie pairs 95, resolved toward the nearer road 80 (share 0.84).

| # | road | interest | exploration | dist mi | fraction of radius | penalty |
|---|---|---|---|---|---|---|
| 1 | Haverhill St | 81.9 | 80.6 | 11.54 | 0.462 | 1.3 |
| 2 | US Hwy 20 | 80.3 | 80 | 5.24 | 0.21 | 0.3 |
| 3 | State Rte 138 | 79.9 | 79.5 | 6.78 | 0.271 | 0.4 |
| 4 | State Rte 35 | 81.4 | 79.5 | 14.15 | 0.566 | 1.9 |
| 5 | Massapoag Ave | 82.6 | 79.4 | 18.21 | 0.728 | 3.2 |
| 6 | Middlesex Tpke | 80.2 | 78.7 | 12.66 | 0.506 | 1.5 |
| 7 | Trapelo Rd | 79 | 78.7 | 5.79 | 0.232 | 0.3 |
| 8 | State Rte 3 A | 79.6 | 78.5 | 10.5 | 0.42 | 1.1 |
| 9 | Winter St | 79.4 | 78.5 | 9.71 | 0.388 | 0.9 |
| 10 | US Hwy 1 | 78.6 | 78.3 | 5.47 | 0.219 | 0.3 |

Entered the top: drv1-trapelo-rd-s1, drv1-state-rte-3-a-c2-s1, drv1-winter-st-c3-s1, drv1-us-hwy-1-c11-s15

Left the top: drv1-washington-st-c46-s1, drv1-congress-st-c3-s1, drv1-state-rte-111-c5-s11, drv1-state-rte-97-c8-s7

