/**
 * Where the Dashboard header's actions land. They are driven by state that lives inside `TerminalsView` (the board on
 * screen, its orchestrator, the layout picked for its project), which Dashboard renders with no props, so the header
 * keeps an empty element with this id and TerminalsView portals them into it: today the board layout switch
 * (`Dashboard · orchestrator layout`).
 */
export const DASHBOARD_HEADER_ACTIONS_SLOT_ID = 'dashboard-header-actions';
